import { jest } from '@jest/globals';


const lockReleaseMock = jest.fn();

const RedisServiceMock = {
  lockRoom: jest.fn(async () => ({ release: lockReleaseMock })),
  getRoomState: jest.fn(),
  setRoomState: jest.fn(),
  nextVersion: jest.fn(),
  setRoomHostIfEmpty: jest.fn(),
  computeCurrentPosition: jest.fn(),
  publish: jest.fn(),
  subscribe: jest.fn(),
};

jest.unstable_mockModule('./redisService.js', () => ({
  RedisService: RedisServiceMock,
}));

// Importar SyncDomainService ya con RedisService mockeado
const { SyncDomainService, RoomNotFoundError } = await import('./syncDomainService.js');

describe('SyncDomainService', () => {
  const fixedNow = 1_700_000_000_000;
  const mockNow = () => jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ------------------------------------------------------------
  // getRoomState & subscribeToUpdates
  // ------------------------------------------------------------
  it('getRoomState delega en RedisService.getRoomState', async () => {
    RedisServiceMock.getRoomState.mockResolvedValue({ roomId: 'room1' });

    const state = await SyncDomainService.getRoomState('room1');

    expect(RedisServiceMock.getRoomState).toHaveBeenCalledWith('room1');
    expect(state).toEqual({ roomId: 'room1' });
  });

  it('subscribeToUpdates usa RedisService.subscribe con el canal de estado', async () => {
    const unsubscribeMock = jest.fn();
    RedisServiceMock.subscribe.mockResolvedValue(unsubscribeMock);

    const handler = jest.fn();
    const unsubscribe = await SyncDomainService.subscribeToUpdates(handler);

    expect(RedisServiceMock.subscribe).toHaveBeenCalledWith(
      'room:state:update',
      expect.any(Function),
    );

    // Simular mensaje recibido
    const [, internalHandler] = RedisServiceMock.subscribe.mock.calls[0];
    const message = { type: 'ROOM_STATE_UPDATED', roomId: 'room1' };

    internalHandler(message);

    expect(handler).toHaveBeenCalledWith(message);
    expect(unsubscribe).toBe(unsubscribeMock);
  });

  // ------------------------------------------------------------
  // play
  // ------------------------------------------------------------
  it('play establece estado playing, actualiza versión y publica control + estado', async () => {
    const nowSpy = mockNow();

    RedisServiceMock.getRoomState.mockResolvedValue({
      trackId: 'old-track',
      basePositionMs: 0,
      playbackState: 'paused',
    });
    RedisServiceMock.nextVersion.mockResolvedValue(10);

    const result = await SyncDomainService.play({
      roomId: 'room1',
      userId: 'user1',
      trackId: 'new-track',
      startPositionMs: 5000,
      playbackRate: 1.5,
    });

    expect(lockReleaseMock).toHaveBeenCalled();

    expect(RedisServiceMock.setRoomHostIfEmpty).toHaveBeenCalledWith('room1', 'user1');

    expect(RedisServiceMock.setRoomState).toHaveBeenCalledTimes(1);
    const [roomId, savedState] = RedisServiceMock.setRoomState.mock.calls[0];
    expect(roomId).toBe('room1');
    expect(savedState).toEqual(
      expect.objectContaining({
        roomId: 'room1',
        version: 10,
        trackId: 'new-track',
        playbackState: 'playing',
        basePositionMs: 5000,
        baseServerTimeMs: fixedNow,
        playbackRate: 1.5,
        updatedByUserId: 'user1',
        updatedAt: fixedNow,
      }),
    );

    expect(RedisServiceMock.publish).toHaveBeenCalledTimes(2);
    const [controlChannel, controlMsg] = RedisServiceMock.publish.mock.calls[0];
    const [stateChannel, stateMsg] = RedisServiceMock.publish.mock.calls[1];

    expect(controlChannel).toBe('room:room1:control');
    expect(controlMsg).toEqual({
      type: 'play',
      roomId: 'room1',
      payload: {
        trackId: 'new-track',
        startPositionMs: 5000,
        startAtServerTimeMs: fixedNow,
        playbackRate: 1.5,
        version: 10,
      },
    });

    expect(stateChannel).toBe('room:state:update');
    expect(stateMsg).toEqual({
      type: 'ROOM_STATE_UPDATED',
      roomId: 'room1',
      state: savedState,
      emittedAt: fixedNow,
    });

    expect(result).toEqual(savedState);

    nowSpy.mockRestore();
  });

  it('play reutiliza el trackId anterior cuando no se pasa trackId', async () => {
    const nowSpy = mockNow();

    RedisServiceMock.getRoomState.mockResolvedValue({
      trackId: 'existing-track',
      basePositionMs: 0,
      playbackState: 'paused',
    });
    RedisServiceMock.nextVersion.mockResolvedValue(2);

    const result = await SyncDomainService.play({
      roomId: 'roomX',
      userId: 'userY',
      startPositionMs: 0,
      playbackRate: 1,
    });

    expect(result.trackId).toBe('existing-track');
    expect(RedisServiceMock.setRoomState).toHaveBeenCalled();
    const [, savedState] = RedisServiceMock.setRoomState.mock.calls[0];
    expect(savedState.trackId).toBe('existing-track');

    nowSpy.mockRestore();
  });

  // ------------------------------------------------------------
  // pause
  // ------------------------------------------------------------
  it('pause lanza RoomNotFoundError si no existe el estado de la sala', async () => {
    RedisServiceMock.getRoomState.mockResolvedValue(null);

    await expect(
      SyncDomainService.pause({ roomId: 'roomMissing', userId: 'user1' }),
    ).rejects.toBeInstanceOf(RoomNotFoundError);

    expect(lockReleaseMock).toHaveBeenCalled();
  });

  it('pause calcula posición actual, cambia a paused y publica control + estado', async () => {
    const nowSpy = mockNow();

    const previousState = {
      roomId: 'room1',
      trackId: 'track1',
      playbackState: 'playing',
      basePositionMs: 1000,
      baseServerTimeMs: fixedNow - 1000,
      playbackRate: 1,
    };

    RedisServiceMock.getRoomState.mockResolvedValue(previousState);
    RedisServiceMock.computeCurrentPosition.mockReturnValue(4321);
    RedisServiceMock.nextVersion.mockResolvedValue(20);

    const result = await SyncDomainService.pause({ roomId: 'room1', userId: 'user1' });

    expect(RedisServiceMock.computeCurrentPosition).toHaveBeenCalledWith(previousState, fixedNow);

    const [, savedState] = RedisServiceMock.setRoomState.mock.calls[0];
    expect(savedState).toEqual(
      expect.objectContaining({
        playbackState: 'paused',
        basePositionMs: 4321,
        baseServerTimeMs: fixedNow,
        playbackRate: 1,
        version: 20,
        updatedByUserId: 'user1',
        updatedAt: fixedNow,
      }),
    );

    const [controlChannel, controlMsg] = RedisServiceMock.publish.mock.calls[0];
    expect(controlChannel).toBe('room:room1:control');
    expect(controlMsg).toEqual({
      type: 'pause',
      roomId: 'room1',
      payload: {
        positionMs: 4321,
        serverTimeMs: fixedNow,
        version: 20,
      },
    });

    expect(result).toEqual(savedState);

    nowSpy.mockRestore();
  });

  // ------------------------------------------------------------
  // seek
  // ------------------------------------------------------------
  it('seek lanza RoomNotFoundError cuando la sala no existe', async () => {
    RedisServiceMock.getRoomState.mockResolvedValue(null);

    await expect(
      SyncDomainService.seek({ roomId: 'roomMissing', userId: 'user1', positionMs: 1000 }),
    ).rejects.toBeInstanceOf(RoomNotFoundError);

    expect(lockReleaseMock).toHaveBeenCalled();
  });

  it('seek actualiza basePositionMs y publica comando seek', async () => {
    const nowSpy = mockNow();

    const previousState = {
      roomId: 'room1',
      trackId: 'track1',
      playbackState: 'playing',
      basePositionMs: 0,
      baseServerTimeMs: fixedNow - 10000,
      playbackRate: 1,
    };

    RedisServiceMock.getRoomState.mockResolvedValue(previousState);
    RedisServiceMock.nextVersion.mockResolvedValue(30);

    const result = await SyncDomainService.seek({
      roomId: 'room1',
      userId: 'user1',
      positionMs: 9876,
    });

    const [, savedState] = RedisServiceMock.setRoomState.mock.calls[0];
    expect(savedState).toEqual(
      expect.objectContaining({
        basePositionMs: 9876,
        baseServerTimeMs: fixedNow,
        version: 30,
        updatedByUserId: 'user1',
        updatedAt: fixedNow,
      }),
    );

    const [controlChannel, controlMsg] = RedisServiceMock.publish.mock.calls[0];
    expect(controlChannel).toBe('room:room1:control');
    expect(controlMsg).toEqual({
      type: 'seek',
      roomId: 'room1',
      payload: {
        positionMs: 9876,
        serverTimeMs: fixedNow,
        version: 30,
      },
    });

    expect(result).toEqual(savedState);

    nowSpy.mockRestore();
  });

  it('seek sanitiza positionMs no numérico a 0', async () => {
    const nowSpy = mockNow();

    const previousState = {
      roomId: 'room1',
      trackId: 'track1',
    };

    RedisServiceMock.getRoomState.mockResolvedValue(previousState);
    RedisServiceMock.nextVersion.mockResolvedValue(5);

    const result = await SyncDomainService.seek({
      roomId: 'room1',
      userId: 'user1',
      positionMs: 'not-a-number',
    });

    const [, savedState] = RedisServiceMock.setRoomState.mock.calls[0];
    expect(savedState.basePositionMs).toBe(0);

    const [, controlMsg] = RedisServiceMock.publish.mock.calls[0];
    expect(controlMsg.payload.positionMs).toBe(0);

    expect(result.basePositionMs).toBe(0);

    nowSpy.mockRestore();
  });

  // ------------------------------------------------------------
  // changeTrack
  // ------------------------------------------------------------
  it('changeTrack cambia el track, pone estado playing y publica control + estado', async () => {
    const nowSpy = mockNow();

    const previousState = {
      roomId: 'room1',
      trackId: 'old-track',
      playbackState: 'paused',
      basePositionMs: 0,
    };

    RedisServiceMock.getRoomState.mockResolvedValue(previousState);
    RedisServiceMock.nextVersion.mockResolvedValue(99);

    const result = await SyncDomainService.changeTrack({
      roomId: 'room1',
      userId: 'user1',
      trackId: 'new-track-xyz',
      startPositionMs: 123,
      playbackRate: 1.25,
    });

    expect(RedisServiceMock.setRoomHostIfEmpty).toHaveBeenCalledWith('room1', 'user1');

    const [, savedState] = RedisServiceMock.setRoomState.mock.calls[0];
    expect(savedState).toEqual(
      expect.objectContaining({
        roomId: 'room1',
        trackId: 'new-track-xyz',
        playbackState: 'playing',
        basePositionMs: 123,
        baseServerTimeMs: fixedNow,
        playbackRate: 1.25,
        version: 99,
        updatedByUserId: 'user1',
        updatedAt: fixedNow,
      }),
    );

    expect(RedisServiceMock.publish).toHaveBeenCalledTimes(2);
    const [controlChannel, controlMsg] = RedisServiceMock.publish.mock.calls[0];
    const [stateChannel, stateMsg] = RedisServiceMock.publish.mock.calls[1];

    expect(controlChannel).toBe('room:room1:control');
    expect(controlMsg).toEqual({
      type: 'trackChanged',
      roomId: 'room1',
      payload: {
        trackId: 'new-track-xyz',
        startPositionMs: 123,
        serverTimeMs: fixedNow,
        version: 99,
      },
    });

    expect(stateChannel).toBe('room:state:update');
    expect(stateMsg).toEqual({
      type: 'ROOM_STATE_UPDATED',
      roomId: 'room1',
      state: savedState,
      emittedAt: fixedNow,
    });

    expect(result).toEqual(savedState);

    nowSpy.mockRestore();
  });
});
