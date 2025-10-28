import { jest } from '@jest/globals';

const decideCorrectionMock = jest.fn();
const recordDriftMock = jest.fn();
const recordRateAdjustMock = jest.fn();
const recordSeekMock = jest.fn();
const userJoinMock = jest.fn();
const userLeaveMock = jest.fn();

const getRoomStateMock = jest.fn();
const getVersionMock = jest.fn().mockResolvedValue(0);
const subscribeMock = jest.fn();
const computeCurrentPositionMock = jest.fn();
const publishMock = jest.fn();

jest.unstable_mockModule('../utils/driftLogic.js', () => ({
    decideCorrection: decideCorrectionMock,
}));

jest.unstable_mockModule('../utils/metrics.js', () => ({
    Metrics: {
        userJoin: userJoinMock,
        userLeave: userLeaveMock,
        recordDrift: recordDriftMock,
        recordRateAdjust: recordRateAdjustMock,
        recordSeek: recordSeekMock,
    },
}));

jest.unstable_mockModule('../services/redisService.js', () => ({
    RedisService: {
        getRoomState: getRoomStateMock,
        getVersion: getVersionMock,
        subscribe: subscribeMock,
        computeCurrentPosition: computeCurrentPositionMock,
        publish: publishMock,
    },
}));

const { handleDriftReport } = await import('../sockets/syncGateway.js');

describe('handleDriftReport', () => {
    const basePayload = {
        roomId: 'room-1',
        clientTimeMs: 1,
        localPositionMs: 100000,
        observedServerTimeMs: 1,
        observedServerPositionMs: 100000,
        jitterMs: 0,
        clientLagMs: 0,
    };

    let fakeSocket;
    let emitted;

    beforeEach(() => {
        emitted = {};
        fakeSocket = {
            emit: jest.fn((event, payload) => {
                emitted[event] = payload;
            }),
        };

        decideCorrectionMock.mockReset();
        recordDriftMock.mockReset();
        recordRateAdjustMock.mockReset();
        recordSeekMock.mockReset();
        getRoomStateMock.mockReset();
        getVersionMock.mockReset().mockResolvedValue(0);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('emits rateAdjust when correction action is rate', async () => {
        decideCorrectionMock.mockReturnValue({
            action: 'rate',
            driftMs: 80,
            payload: { playbackRate: 1.01, durationMs: 2000, reason: 'drift 80ms' },
        });

        await handleDriftReport(fakeSocket, basePayload);

        expect(recordDriftMock).toHaveBeenCalledWith('room-1', 80);
        expect(recordRateAdjustMock).toHaveBeenCalledWith('room-1');
        expect(recordSeekMock).not.toHaveBeenCalled();

        expect(fakeSocket.emit).toHaveBeenCalledWith(
            'rateAdjust',
            expect.objectContaining({
                playbackRate: 1.01,
                durationMs: 2000,
                reason: 'drift 80ms',
            }),
        );
        expect(emitted.rateAdjust).toBeDefined();
    });

    it('emits seek with version when correction action is seek', async () => {
        decideCorrectionMock.mockReturnValue({
            action: 'seek',
            driftMs: 220,
            payload: { positionMs: 12345, serverTimeMs: 999999 },
        });
        getRoomStateMock.mockResolvedValue({ version: 42 });

        await handleDriftReport(fakeSocket, basePayload);

        expect(recordDriftMock).toHaveBeenCalledWith('room-1', 220);
        expect(recordSeekMock).toHaveBeenCalledWith('room-1');
        expect(recordRateAdjustMock).not.toHaveBeenCalled();
        expect(getRoomStateMock).toHaveBeenCalledWith('room-1');

        expect(fakeSocket.emit).toHaveBeenCalledWith(
            'seek',
            expect.objectContaining({
                positionMs: 12345,
                serverTimeMs: 999999,
                version: 42,
            }),
        );
        expect(emitted.seek).toEqual(
            expect.objectContaining({
                positionMs: 12345,
                serverTimeMs: 999999,
                version: 42,
            }),
        );
    });

    it('ignores report when correction action is ignore', async () => {
        decideCorrectionMock.mockReturnValue({
            action: 'ignore',
            driftMs: 20,
            payload: undefined,
        });

        await handleDriftReport(fakeSocket, basePayload);

        expect(recordDriftMock).toHaveBeenCalledWith('room-1', 20);
        expect(recordRateAdjustMock).not.toHaveBeenCalled();
        expect(recordSeekMock).not.toHaveBeenCalled();
        expect(fakeSocket.emit).not.toHaveBeenCalled();
    });
});
