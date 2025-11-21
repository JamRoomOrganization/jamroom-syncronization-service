import { jest } from '@jest/globals';

const RedisServiceModule = await import('../services/redisService.js');
const { SyncDomainService } = await import('../services/syncDomainService.js');

describe('SyncDomainService.play', () => {
    let releaseMock;

    beforeEach(() => {
        releaseMock = jest.fn().mockResolvedValue();

        jest.spyOn(RedisServiceModule.RedisService, 'lockRoom').mockResolvedValue({
            release: releaseMock,
        });
        jest.spyOn(RedisServiceModule.RedisService, 'nextVersion').mockResolvedValue(42);
        jest.spyOn(RedisServiceModule.RedisService, 'setRoomState').mockResolvedValue();
        jest.spyOn(RedisServiceModule.RedisService, 'publish').mockResolvedValue();
        jest.spyOn(RedisServiceModule.RedisService, 'getRoomState').mockResolvedValue(null);
    });

    afterEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    it('persists playing state, publishes control event and returns version', async () => {
        const result = await SyncDomainService.play({
            roomId: 'r1',
            userId: 'u1',
            trackId: 't1',
            startPositionMs: 0,
        });

        expect(
            RedisServiceModule.RedisService.setRoomState,
        ).toHaveBeenCalledWith(
            'r1',
            expect.objectContaining({
                playbackState: 'playing',
                version: 42,
            }),
        );

        const publishCalls = RedisServiceModule.RedisService.publish.mock.calls;
        const controlCall = publishCalls.find(([channel]) => channel === 'room:r1:control');

        expect(controlCall).toBeDefined();
        expect(controlCall?.[1]).toEqual(
            expect.objectContaining({
                type: 'play',
                roomId: 'r1',
                payload: expect.objectContaining({
                    trackId: 't1',
                    version: 42,
                }),
            }),
        );

        expect(result.version).toBe(42);
        expect(releaseMock).toHaveBeenCalledTimes(1);
    });
});
