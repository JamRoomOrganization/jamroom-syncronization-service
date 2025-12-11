import { jest } from '@jest/globals';

// Mocks de dependencias externas
const redisServiceMock = {
  getRoomState: jest.fn(),
  computeCurrentPosition: jest.fn(),
  getVersion: jest.fn(),
};

const syncDomainServiceMock = {
  play: jest.fn(),
  pause: jest.fn(),
  seek: jest.fn(),
  changeTrack: jest.fn(),
};

const redisClientMock = { ping: jest.fn() };
const pubClientMock = { ping: jest.fn() };
const subClientMock = { ping: jest.fn() };

const getRequestIdMock = jest.fn(() => 'test-request-id');

// ESM mocking
jest.unstable_mockModule('../services/redisService.js', () => ({
  RedisService: redisServiceMock,
}));

jest.unstable_mockModule('../services/syncDomainService.js', () => ({
  SyncDomainService: syncDomainServiceMock,
}));

jest.unstable_mockModule('../config/redis.js', () => ({
  redisClient: redisClientMock,
  pubClient: pubClientMock,
  subClient: subClientMock,
}));

jest.unstable_mockModule('../utils/requestLogger.js', () => ({
  getRequestId: getRequestIdMock,
}));

// Importar el módulo bajo prueba DESPUÉS de configurar los mocks
const { registerSyncRoutes } = await import('./syncController.js');

// Helper para crear un "app" minimalista compatible con Express
function createMockApp() {
  return {
    get: jest.fn(),
    post: jest.fn(),
  };
}

// Helper para crear un res mock compatible (status().json(), set())
function createMockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  };
}

// Helper para obtener el handler de una ruta registrada
function getRouteHandler(app, method, path) {
  const calls = app[method].mock.calls;
  const entry = calls.find(([registeredPath]) => registeredPath === path);
  if (!entry) {
    throw new Error(`Ruta ${method.toUpperCase()} ${path} no encontrada en el mock de app`);
  }
  return entry[1];
}

describe('registerSyncRoutes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createMockApp();
    registerSyncRoutes(app);
  });

  // ---------------------------------------------------------------------------
  // /health
  // ---------------------------------------------------------------------------
  it('GET /health devuelve 200 cuando todos los clientes Redis están sanos', async () => {
    redisClientMock.ping.mockResolvedValue('PONG');
    pubClientMock.ping.mockResolvedValue('PONG');
    subClientMock.ping.mockResolvedValue('PONG');

    const handler = getRouteHandler(app, 'get', '/health');
    const req = {};
    const res = createMockRes();

    await handler(req, res);

    expect(redisClientMock.ping).toHaveBeenCalled();
    expect(pubClientMock.ping).toHaveBeenCalled();
    expect(subClientMock.ping).toHaveBeenCalled();

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({
      redis: true,
      redisPub: true,
      redisSub: true,
    });
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.timestamp).toBe('number');
  });

  it('GET /health devuelve 503 cuando algún cliente Redis falla', async () => {
    redisClientMock.ping.mockResolvedValue('PONG');
    pubClientMock.ping.mockRejectedValue(new Error('pub down'));
    subClientMock.ping.mockResolvedValue('PONG');

    const handler = getRouteHandler(app, 'get', '/health');
    const req = {};
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(503);
    const body = res.json.mock.calls[0][0];
    expect(body.status).toBe('degraded');
    expect(body.checks.redis).toBe(true);
    expect(body.checks.redisPub).toBe(false);
    expect(body.checks.redisSub).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // /v1/tracks/:trackId/streamUrl
  // ---------------------------------------------------------------------------
  it('GET /v1/tracks/:trackId/streamUrl devuelve 400 si trackId no viene en params', async () => {
    const handler = getRouteHandler(app, 'get', '/v1/tracks/:trackId/streamUrl');
    const req = { params: { } }; // sin trackId
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'invalid_trackId' });
  });

  it('GET /v1/tracks/:trackId/streamUrl devuelve el trackId y streamUrl cuando el param es válido', async () => {
    const handler = getRouteHandler(app, 'get', '/v1/tracks/:trackId/streamUrl');
    const req = { params: { trackId: 'track-123' } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      trackId: 'track-123',
      streamUrl: 'track-123',
    });
  });

  // ---------------------------------------------------------------------------
  // /v1/rooms/:roomId/state
  // ---------------------------------------------------------------------------
  it('GET /v1/rooms/:roomId/state devuelve 404 si la sala no existe', async () => {
    redisServiceMock.getRoomState.mockResolvedValue(null);

    const handler = getRouteHandler(app, 'get', '/v1/rooms/:roomId/state');
    const req = { params: { roomId: 'room-1' } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(redisServiceMock.getRoomState).toHaveBeenCalledWith('room-1');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'room_not_found' });
  });

  it('GET /v1/rooms/:roomId/state devuelve el estado calculado cuando la sala existe', async () => {
    redisServiceMock.getRoomState.mockResolvedValue({
      trackId: 'track-1',
      playbackState: 'playing',
      version: 7,
    });
    redisServiceMock.computeCurrentPosition.mockReturnValue(4321);

    const handler = getRouteHandler(app, 'get', '/v1/rooms/:roomId/state');
    const req = { params: { roomId: 'room-1' } };
    const res = createMockRes();

    await handler(req, res);

    expect(redisServiceMock.getRoomState).toHaveBeenCalledWith('room-1');
    expect(redisServiceMock.computeCurrentPosition).toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];

    expect(body).toMatchObject({
      roomId: 'room-1',
      trackId: 'track-1',
      playbackState: 'playing',
      effectivePositionMs: 4321,
      version: 7,
    });
    expect(typeof body.serverTimeMs).toBe('number');
  });

  it('GET /v1/rooms/:roomId/state devuelve 500 ante errores inesperados en RedisService', async () => {
    redisServiceMock.getRoomState.mockRejectedValue(new Error('boom'));

    const handler = getRouteHandler(app, 'get', '/v1/rooms/:roomId/state');
    const req = { params: { roomId: 'room-err' } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'internal_error' });
  });

  // ---------------------------------------------------------------------------
  // /v1/rooms/:roomId/play
  // ---------------------------------------------------------------------------
  it('POST /v1/rooms/:roomId/play responde 400 si userId es inválido', async () => {
    const handler = getRouteHandler(app, 'post', '/v1/rooms/:roomId/play');
    const req = {
      params: { roomId: 'room-1' },
      body: {
        userId: '   ', // inválido
        trackId: 'track-1',
        startPositionMs: 0,
      },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_body',
      field: 'userId',
    });
    expect(syncDomainServiceMock.play).not.toHaveBeenCalled();
  });

  it('POST /v1/rooms/:roomId/play responde 400 si trackId es inválido', async () => {
    const handler = getRouteHandler(app, 'post', '/v1/rooms/:roomId/play');
    const req = {
      params: { roomId: 'room-1' },
      body: {
        userId: 'user-1',
        trackId: '   ', // inválido
        startPositionMs: 0,
      },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_body',
      field: 'trackId',
    });
    expect(syncDomainServiceMock.play).not.toHaveBeenCalled();
  });

  it('POST /v1/rooms/:roomId/play responde 400 si startPositionMs es inválido', async () => {
    const handler = getRouteHandler(app, 'post', '/v1/rooms/:roomId/play');
    const req = {
      params: { roomId: 'room-1' },
      body: {
        userId: 'user-1',
        trackId: 'track-1',
        startPositionMs: -10,
      },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_body',
      field: 'startPositionMs',
    });
    expect(syncDomainServiceMock.play).not.toHaveBeenCalled();
  });

  it('POST /v1/rooms/:roomId/play ejecuta SyncDomainService.play y devuelve el resultado cuando es válido', async () => {
    const handler = getRouteHandler(app, 'post', '/v1/rooms/:roomId/play');
    const req = {
      params: { roomId: 'room-1' },
      body: {
        userId: 'user-1',
        trackId: 'track-1',
        startPositionMs: 1234,
      },
    };
    const res = createMockRes();

    const fakeResult = { roomId: 'room-1', status: 'playing' };
    syncDomainServiceMock.play.mockResolvedValue(fakeResult);

    await handler(req, res);

    expect(syncDomainServiceMock.play).toHaveBeenCalledWith({
      roomId: 'room-1',
      userId: 'user-1',
      trackId: 'track-1',
      startPositionMs: 1234,
    });
    expect(res.json).toHaveBeenCalledWith(fakeResult);
  });

  it('POST /v1/rooms/:roomId/play devuelve 404 cuando SyncDomainService.play lanza room_not_found', async () => {
    const handler = getRouteHandler(app, 'post', '/v1/rooms/:roomId/play');
    const req = {
      params: { roomId: 'room-404' },
      body: {
        userId: 'user-1',
        trackId: 'track-1',
        startPositionMs: 0,
      },
    };
    const res = createMockRes();

    const err = new Error('room_not_found');
    syncDomainServiceMock.play.mockRejectedValue(err);

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'room_not_found' });
  });

  // ---------------------------------------------------------------------------
  // /v1/rooms/:roomId/pause
  // ---------------------------------------------------------------------------
  it('POST /v1/rooms/:roomId/pause responde 400 si userId es inválido', async () => {
    const handler = getRouteHandler(app, 'post', '/v1/rooms/:roomId/pause');
    const req = {
      params: { roomId: 'room-1' },
      body: { userId: '   ' },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_body',
      field: 'userId',
    });
    expect(syncDomainServiceMock.pause).not.toHaveBeenCalled();
  });

  it('POST /v1/rooms/:roomId/pause ejecuta SyncDomainService.pause cuando el body es válido', async () => {
    const handler = getRouteHandler(app, 'post', '/v1/rooms/:roomId/pause');
    const req = {
      params: { roomId: 'room-1' },
      body: { userId: 'user-1' },
    };
    const res = createMockRes();

    const fakeResult = { roomId: 'room-1', playbackState: 'paused' };
    syncDomainServiceMock.pause.mockResolvedValue(fakeResult);

    await handler(req, res);

    expect(syncDomainServiceMock.pause).toHaveBeenCalledWith({
      roomId: 'room-1',
      userId: 'user-1',
    });
    expect(res.json).toHaveBeenCalledWith(fakeResult);
  });

  // ---------------------------------------------------------------------------
  // /v1/rooms/:roomId/seek
  // ---------------------------------------------------------------------------
  it('POST /v1/rooms/:roomId/seek responde 400 si positionMs es inválido', async () => {
    const handler = getRouteHandler(app, 'post', '/v1/rooms/:roomId/seek');
    const req = {
      params: { roomId: 'room-1' },
      body: {
        userId: 'user-1',
        positionMs: -5,
      },
    };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'invalid_body',
      field: 'positionMs',
    });
    expect(syncDomainServiceMock.seek).not.toHaveBeenCalled();
  });

  it('POST /v1/rooms/:roomId/seek ejecuta SyncDomainService.seek cuando es válido', async () => {
    const handler = getRouteHandler(app, 'post', '/v1/rooms/:roomId/seek');
    const req = {
      params: { roomId: 'room-1' },
      body: {
        userId: 'user-1',
        positionMs: 5000,
      },
    };
    const res = createMockRes();

    const fakeResult = { roomId: 'room-1', positionMs: 5000 };
    syncDomainServiceMock.seek.mockResolvedValue(fakeResult);

    await handler(req, res);

    expect(syncDomainServiceMock.seek).toHaveBeenCalledWith({
      roomId: 'room-1',
      userId: 'user-1',
      positionMs: 5000,
    });
    expect(res.json).toHaveBeenCalledWith(fakeResult);
  });

  // ---------------------------------------------------------------------------
  // /v1/rooms/:roomId/track
  // ---------------------------------------------------------------------------
  it('POST /v1/rooms/:roomId/track ejecuta SyncDomainService.changeTrack cuando el body es válido', async () => {
    const handler = getRouteHandler(app, 'post', '/v1/rooms/:roomId/track');
    const req = {
      params: { roomId: 'room-1' },
      body: {
        userId: 'user-1',
        trackId: 'track-new',
        startPositionMs: 250,
      },
    };
    const res = createMockRes();

    const fakeResult = { roomId: 'room-1', trackId: 'track-new' };
    syncDomainServiceMock.changeTrack.mockResolvedValue(fakeResult);

    await handler(req, res);

    expect(syncDomainServiceMock.changeTrack).toHaveBeenCalledWith({
      roomId: 'room-1',
      userId: 'user-1',
      trackId: 'track-new',
      startPositionMs: 250,
    });
    expect(res.json).toHaveBeenCalledWith(fakeResult);
  });

  // ---------------------------------------------------------------------------
  // /debug/state/:roomId
  // ---------------------------------------------------------------------------
  it('GET /debug/state/:roomId devuelve estado y versión cuando RedisService responde correctamente', async () => {
    redisServiceMock.getRoomState.mockResolvedValue({ foo: 'bar' });
    redisServiceMock.getVersion.mockResolvedValue(42);

    const handler = getRouteHandler(app, 'get', '/debug/state/:roomId');
    const req = { params: { roomId: 'room-debug' } };
    const res = createMockRes();

    await handler(req, res);

    expect(redisServiceMock.getRoomState).toHaveBeenCalledWith('room-debug');
    expect(redisServiceMock.getVersion).toHaveBeenCalledWith('room-debug');

    const body = res.json.mock.calls[0][0];
    expect(body).toEqual({
      exists: true,
      roomState: { foo: 'bar' },
      version: 42,
    });
  });

  it('GET /debug/state/:roomId devuelve exists=false cuando roomState está vacío', async () => {
    redisServiceMock.getRoomState.mockResolvedValue({});
    redisServiceMock.getVersion.mockResolvedValue(null);

    const handler = getRouteHandler(app, 'get', '/debug/state/:roomId');
    const req = { params: { roomId: 'room-empty' } };
    const res = createMockRes();

    await handler(req, res);

    const body = res.json.mock.calls[0][0];
    expect(body.exists).toBe(false);
    expect(body.roomState).toEqual({});
    expect(body.version).toBeNull();
  });

  it('GET /debug/state/:roomId devuelve 500 ante errores inesperados', async () => {
    redisServiceMock.getRoomState.mockRejectedValue(new Error('debug error'));

    const handler = getRouteHandler(app, 'get', '/debug/state/:roomId');
    const req = { params: { roomId: 'room-error' } };
    const res = createMockRes();

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'internal_debug_error',
    });
  });
});
