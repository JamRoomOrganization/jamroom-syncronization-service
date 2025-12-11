import { jest } from '@jest/globals';

// Mocks de dependencias
const redisClientMock = {
  hGetAll: jest.fn(),
  hSet: jest.fn(),
  expire: jest.fn(),
  get: jest.fn(),
  incr: jest.fn(),
  setNX: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

const pubClientMock = {
  publish: jest.fn(),
};

const subClientMock = {
  pSubscribe: jest.fn(),
  pUnsubscribe: jest.fn(),
};

jest.unstable_mockModule('../config/redis.js', () => ({
  redisClient: redisClientMock,
  pubClient: pubClientMock,
  subClient: subClientMock,
  REDLOCK_CONFIG: { LOCK_TTL_MS: 5000 },
}));

jest.unstable_mockModule('../utils/requestLogger.js', () => ({
  getRequestId: jest.fn(() => 'req-123'),
}));

// Importar el módulo ya con los mocks aplicados
const { RedisService } = await import('./redisService.js');

// Constante local para TTL (debe coincidir con el código)
const ROOM_TTL_SECONDS = 60 * 30;

describe('RedisService', () => {
  const originalDateNow = Date.now;

  beforeEach(() => {
    jest.clearAllMocks();
    Date.now = originalDateNow;

    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ------------------------------------------------------------
  // getRoomState
  // ------------------------------------------------------------
  it('getRoomState devuelve null cuando no hay estado en Redis', async () => {
    redisClientMock.hGetAll.mockResolvedValue({});

    const result = await RedisService.getRoomState('room1');
    expect(redisClientMock.hGetAll).toHaveBeenCalledWith('room:room1:state');
    expect(result).toBeNull();
  });

  it('getRoomState normaliza tipos y campos updatedBy/updatedByUserId', async () => {
    redisClientMock.hGetAll.mockResolvedValue({
      trackId: 'track-1',
      playbackState: 'playing',
      basePositionMs: '1000',
      baseServerTimeMs: '2000',
      playbackRate: '1.5',
      updatedByUserId: 'user-1',
      updatedAt: '3000',
      version: '5',
      lastSyncMs: '4000',
    });

    const result = await RedisService.getRoomState('room1');

    expect(result).toEqual({
      roomId: 'room1',
      trackId: 'track-1',
      playbackState: 'playing',
      basePositionMs: 1000,
      baseServerTimeMs: 2000,
      playbackRate: 1.5,
      updatedBy: 'user-1',
      updatedAt: 3000,
      version: 5,
      lastSyncMs: 4000,
    });
  });

  it('getRoomState usa updatedBy si existe y no updatedByUserId', async () => {
    redisClientMock.hGetAll.mockResolvedValue({
      trackId: 'track-1',
      playbackState: 'paused',
      updatedBy: 'legacy-user',
    });

    const result = await RedisService.getRoomState('roomA');

    expect(result.updatedBy).toBe('legacy-user');
    expect(result.playbackState).toBe('paused');
  });

  // ------------------------------------------------------------
  // setRoomState
  // ------------------------------------------------------------
  it('setRoomState guarda el hash con valores string y refresca TTL', async () => {
    redisClientMock.hSet.mockResolvedValue(1);
    redisClientMock.expire.mockResolvedValue(true);

    const state = {
      roomId: 'room1',
      trackId: 'track-1',
      basePositionMs: 1234,
      playbackRate: 1.25,
      somethingNull: null,
    };

    await RedisService.setRoomState('room1', state);

    expect(redisClientMock.hSet).toHaveBeenCalledTimes(1);
    const [key, payload] = redisClientMock.hSet.mock.calls[0];

    expect(key).toBe('room:room1:state');
    expect(payload).toEqual({
      roomId: 'room1',
      trackId: 'track-1',
      basePositionMs: '1234',
      playbackRate: '1.25',
    });
    expect(redisClientMock.expire).toHaveBeenCalledWith('room:room1:state', ROOM_TTL_SECONDS);
  });

  it('setRoomState asegura roomId en el payload aunque no venga en el estado', async () => {
    redisClientMock.hSet.mockResolvedValue(1);
    redisClientMock.expire.mockResolvedValue(true);

    const state = {
      trackId: 'track-xyz',
    };

    await RedisService.setRoomState('room42', state);

    const [key, payload] = redisClientMock.hSet.mock.calls[0];
    expect(key).toBe('room:room42:state');
    expect(payload.roomId).toBe('room42');
  });

  // ------------------------------------------------------------
  // version helpers
  // ------------------------------------------------------------
  it('getVersion devuelve 0 si el valor en Redis es inválido', async () => {
    redisClientMock.get.mockResolvedValue('no-number');

    const version = await RedisService.getVersion('room1');
    expect(redisClientMock.get).toHaveBeenCalledWith('room:room1:version');
    expect(version).toBe(0);
  });

  it('nextVersion incrementa y pone TTL', async () => {
    redisClientMock.incr.mockResolvedValue(7);
    redisClientMock.expire.mockResolvedValue(true);

    const version = await RedisService.nextVersion('roomX');
    expect(redisClientMock.incr).toHaveBeenCalledWith('room:roomX:version');
    expect(redisClientMock.expire).toHaveBeenCalledWith('room:roomX:version', ROOM_TTL_SECONDS);
    expect(version).toBe(7);
  });

  // ------------------------------------------------------------
  // host helpers
  // ------------------------------------------------------------
  it('getRoomHost devuelve null si no hay host', async () => {
    redisClientMock.get.mockResolvedValue(null);

    const host = await RedisService.getRoomHost('room1');
    expect(host).toBeNull();
  });

  it('setRoomHostIfEmpty retorna false si userId es falsy y no toca Redis', async () => {
    const result = await RedisService.setRoomHostIfEmpty('room1', null);
    expect(result).toBe(false);
    expect(redisClientMock.setNX).not.toHaveBeenCalled();
  });

  it('setRoomHostIfEmpty establece el host y pone TTL cuando el setNX es exitoso', async () => {
    redisClientMock.setNX.mockResolvedValue(true);
    redisClientMock.expire.mockResolvedValue(true);

    const result = await RedisService.setRoomHostIfEmpty('room1', 'user1');

    expect(result).toBe(true);
    expect(redisClientMock.setNX).toHaveBeenCalledWith('room:room1:hostUserId', 'user1');
    expect(redisClientMock.expire).toHaveBeenCalledWith('room:room1:hostUserId', ROOM_TTL_SECONDS);
  });

  it('setRoomHostIfEmpty no pone TTL cuando el setNX no adquiere el lock', async () => {
    redisClientMock.setNX.mockResolvedValue(false);

    const result = await RedisService.setRoomHostIfEmpty('room1', 'user1');

    expect(result).toBe(false);
    expect(redisClientMock.expire).not.toHaveBeenCalled();
  });

  it('clearRoomHost borra la clave del host', async () => {
    redisClientMock.del.mockResolvedValue(1);

    await RedisService.clearRoomHost('room1');

    expect(redisClientMock.del).toHaveBeenCalledWith('room:room1:hostUserId');
  });

  // ------------------------------------------------------------
  // lockRoom
  // ------------------------------------------------------------
  it('lockRoom adquiere lock y release borra la clave si el token coincide', async () => {
    let savedToken;
    redisClientMock.set.mockImplementation(async (key, token, options) => {
      savedToken = token;
      return 'OK';
    });
    redisClientMock.get.mockImplementation(async () => savedToken);
    redisClientMock.del.mockResolvedValue(1);

    const lock = await RedisService.lockRoom('room1', 1234);

    expect(typeof lock.release).toBe('function');
    expect(redisClientMock.set).toHaveBeenCalledWith(
      'lock:room:room1',
      expect.any(String),
      expect.objectContaining({ PX: 1234, NX: true }),
    );

    await lock.release();

    expect(redisClientMock.get).toHaveBeenCalledWith('lock:room:room1');
    expect(redisClientMock.del).toHaveBeenCalledWith('lock:room:room1');
  });

  it('lockRoom devuelve lock no-op cuando no se puede adquirir el lock', async () => {
    redisClientMock.set.mockResolvedValue(null);

    const lock = await RedisService.lockRoom('room1', 1000);

    expect(typeof lock.release).toBe('function');
    await lock.release(); // no debería lanzar ni tocar Redis
    expect(redisClientMock.get).not.toHaveBeenCalled();
    expect(redisClientMock.del).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled(); // log de "lock NOT acquired"
  });

  it('lockRoom hace fallback no-op cuando Redis lanza error', async () => {
    redisClientMock.set.mockRejectedValue(new Error('redis down'));

    const lock = await RedisService.lockRoom('room1', 1000);

    expect(typeof lock.release).toBe('function');
    await lock.release(); // no debe lanzar
    expect(console.error).toHaveBeenCalled(); // log de error al adquirir lock
  });

  // ------------------------------------------------------------
  // publish
  // ------------------------------------------------------------
  it('publish envuelve el mensaje con _meta y publica JSON', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(123456789);
    pubClientMock.publish.mockResolvedValue(1);

    await RedisService.publish('channel:1', { foo: 'bar' });

    expect(pubClientMock.publish).toHaveBeenCalledTimes(1);
    const [channel, rawMessage] = pubClientMock.publish.mock.calls[0];
    expect(channel).toBe('channel:1');

    const parsed = JSON.parse(rawMessage);
    expect(parsed.foo).toBe('bar');
    expect(parsed._meta).toEqual({
      requestId: 'req-123',
      timestamp: 123456789,
    });
  });

  it('publish loguea y relanza el error cuando publish falla', async () => {
    const error = new Error('publish failed');
    pubClientMock.publish.mockRejectedValue(error);
    jest.spyOn(Date, 'now').mockReturnValue(1111);

    await expect(
      RedisService.publish('ch', { a: 1 }),
    ).rejects.toBe(error);

    expect(console.error).toHaveBeenCalled();
  });

  // ------------------------------------------------------------
  // subscribe
  // ------------------------------------------------------------
  it('subscribe registra un handler y devuelve función de desuscripción', async () => {
    let capturedHandler;
    subClientMock.pSubscribe.mockImplementation(async (pattern, handler) => {
      capturedHandler = handler;
    });
    subClientMock.pUnsubscribe.mockResolvedValue(1);

    const handler = jest.fn();
    const unsubscribe = await RedisService.subscribe('room:*', handler);

    expect(subClientMock.pSubscribe).toHaveBeenCalledWith('room:*', expect.any(Function));

    const message = {
      foo: 'bar',
      _meta: { requestId: 'req-123' },
    };

    // Simular mensaje entrante
    await capturedHandler(JSON.stringify(message), 'room:abc');

    expect(handler).toHaveBeenCalledWith(message, 'room:abc');

    // Desuscripción
    await unsubscribe();
    expect(subClientMock.pUnsubscribe).toHaveBeenCalledWith('room:*');
  });

  it('subscribe maneja errores en handler async y los loguea', async () => {
    let capturedHandler;
    subClientMock.pSubscribe.mockImplementation(async (pattern, handler) => {
      capturedHandler = handler;
    });

    const failingHandler = jest.fn(() => Promise.reject(new Error('handler boom')));

    await RedisService.subscribe('room:*', failingHandler);

    const message = {
      foo: 'bar',
      _meta: { requestId: 'req-123' },
    };

    await capturedHandler(JSON.stringify(message), 'room:abc');

    expect(failingHandler).toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      '[subscribe] Async handler error',
      expect.objectContaining({
        requestId: 'req-123',
        pattern: 'room:*',
        channel: 'room:abc',
        error: 'handler boom',
      }),
    );
  });

  it('subscribe maneja JSON inválido y loguea el error', async () => {
    let capturedHandler;
    subClientMock.pSubscribe.mockImplementation(async (pattern, handler) => {
      capturedHandler = handler;
    });

    const handler = jest.fn();
    await RedisService.subscribe('room:*', handler);

    await capturedHandler('NOT-JSON', 'room:abc');

    expect(handler).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      '[subscribe] Handler error',
      expect.objectContaining({
        pattern: 'room:*',
        channel: 'room:abc',
        error: expect.any(String),
      }),
    );
  });

  // ------------------------------------------------------------
  // computeCurrentPosition
  // ------------------------------------------------------------
  it('computeCurrentPosition devuelve 0 cuando no hay estado', () => {
    expect(RedisService.computeCurrentPosition(null)).toBe(0);
  });

  it('computeCurrentPosition respeta basePositionMs cuando está pausado', () => {
    const state = {
      playbackState: 'paused',
      basePositionMs: '1500',
    };

    const position = RedisService.computeCurrentPosition(state, 999999);
    expect(position).toBe(1500);
  });

  it('computeCurrentPosition avanza posición cuando está playing', () => {
    const state = {
      playbackState: 'playing',
      basePositionMs: 1000,
      baseServerTimeMs: 1000,
      playbackRate: 1,
    };

    const position = RedisService.computeCurrentPosition(state, 2000);
    // 1000 + (2000 - 1000) * 1 = 2000
    expect(position).toBe(2000);
  });

  it('computeCurrentPosition clampa valores negativos a 0', () => {
    const state = {
      playbackState: 'playing',
      basePositionMs: 0,
      baseServerTimeMs: 2000,
      playbackRate: 1,
    };

    const position = RedisService.computeCurrentPosition(state, 1000);
    expect(position).toBe(0);
  });
});
