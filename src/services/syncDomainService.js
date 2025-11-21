import { RedisService } from './redisService.js';

const STATE_UPDATE_CHANNEL = 'room:state:update';
const CONTROL_CHANNEL = (roomId) => `room:${roomId}:control`;

const nowMs = () => Date.now();

const ensureTrackId = (trackId) => {
    if (!trackId || typeof trackId !== 'string') {
        throw new Error('invalid_track');
    }
    return trackId;
};

const publishStateUpdate = async (roomId, state) => {
    await RedisService.publish(STATE_UPDATE_CHANNEL, {
        type: 'ROOM_STATE_UPDATED',
        roomId,
        state,
        emittedAt: nowMs(),
    });
};

export class RoomNotFoundError extends Error {
    constructor(roomId) {
        super(`Room ${roomId} not found`);
        this.name = 'RoomNotFoundError';
        this.roomId = roomId;
    }
}

export const SyncDomainService = {
    async getRoomState(roomId) {
        return RedisService.getRoomState(roomId);
    },

    async subscribeToUpdates(handler) {
        return RedisService.subscribe(STATE_UPDATE_CHANNEL, (message) => handler(message));
    },

    async play({ roomId, userId, trackId, startPositionMs = 0, playbackRate = 1 }) {
        const lock = await RedisService.lockRoom(roomId);
        const release = lock.release?.bind(lock);

        try {
            const now = nowMs();
            const previousState = (await RedisService.getRoomState(roomId)) || {};

            const resolvedTrackId = ensureTrackId(trackId ?? previousState.trackId);
            const version = await RedisService.nextVersion(roomId);

            if (userId) {
                await RedisService.setRoomHostIfEmpty(roomId, userId);
            }

            const updatedState = {
                ...previousState,
                roomId,
                version,
                trackId: resolvedTrackId,
                playbackState: 'playing',
                basePositionMs: typeof startPositionMs === 'number' ? startPositionMs : 0,
                baseServerTimeMs: now,
                playbackRate: typeof playbackRate === 'number' ? playbackRate : 1,
                updatedByUserId: userId ?? null,
                updatedAt: now,
            };

            await RedisService.setRoomState(roomId, updatedState);

            await RedisService.publish(CONTROL_CHANNEL(roomId), {
                type: 'play',
                roomId,
                payload: {
                    trackId: updatedState.trackId,
                    startPositionMs: updatedState.basePositionMs,
                    startAtServerTimeMs: now,
                    playbackRate: updatedState.playbackRate,
                    version,
                },
            });

            await publishStateUpdate(roomId, updatedState);

            return updatedState;
        } finally {
            if (typeof release === 'function') {
                await release().catch((error) => {
                    console.warn(`Failed to release lock for room ${roomId}`, error);
                });
            }
        }
    },

    async pause({ roomId, userId }) {
        const lock = await RedisService.lockRoom(roomId);
        const release = lock.release?.bind(lock);

        try {
            const now = nowMs();
            const previousState = await RedisService.getRoomState(roomId);
            if (!previousState) {
                throw new RoomNotFoundError(roomId);
            }

            const positionMs = Math.floor(RedisService.computeCurrentPosition(previousState, now));
            const version = await RedisService.nextVersion(roomId);

            const updatedState = {
                ...previousState,
                version,
                playbackState: 'paused',
                basePositionMs: positionMs,
                baseServerTimeMs: now,
                playbackRate: 1,
                updatedByUserId: userId ?? null,
                updatedAt: now,
            };

            await RedisService.setRoomState(roomId, updatedState);

            await RedisService.publish(CONTROL_CHANNEL(roomId), {
                type: 'pause',
                roomId,
                payload: {
                    positionMs,
                    serverTimeMs: now,
                    version,
                },
            });

            await publishStateUpdate(roomId, updatedState);

            return updatedState;
        } finally {
            if (typeof release === 'function') {
                await release().catch((error) => {
                    console.warn(`Failed to release lock for room ${roomId}`, error);
                });
            }
        }
    },

    async seek({ roomId, userId, positionMs }) {
        const lock = await RedisService.lockRoom(roomId);
        const release = lock.release?.bind(lock);

        try {
            const now = nowMs();
            const previousState = await RedisService.getRoomState(roomId);
            if (!previousState) {
                throw new RoomNotFoundError(roomId);
            }

            const sanitizedPosition = typeof positionMs === 'number' ? positionMs : 0;
            const version = await RedisService.nextVersion(roomId);

            const updatedState = {
                ...previousState,
                version,
                basePositionMs: sanitizedPosition,
                baseServerTimeMs: now,
                updatedByUserId: userId ?? null,
                updatedAt: now,
            };

            await RedisService.setRoomState(roomId, updatedState);

            await RedisService.publish(CONTROL_CHANNEL(roomId), {
                type: 'seek',
                roomId,
                payload: {
                    positionMs: sanitizedPosition,
                    serverTimeMs: now,
                    version,
                },
            });

            await publishStateUpdate(roomId, updatedState);

            return updatedState;
        } finally {
            if (typeof release === 'function') {
                await release().catch((error) => {
                    console.warn(`Failed to release lock for room ${roomId}`, error);
                });
            }
        }
    },

    async changeTrack({ roomId, userId, trackId, startPositionMs = 0, playbackRate = 1 }) {
        const lock = await RedisService.lockRoom(roomId);
        const release = lock.release?.bind(lock);

        try {
            const now = nowMs();
            const previousState = (await RedisService.getRoomState(roomId)) || {};
            const resolvedTrackId = ensureTrackId(trackId);
            const version = await RedisService.nextVersion(roomId);

            if (userId) {
                await RedisService.setRoomHostIfEmpty(roomId, userId);
            }

            const updatedState = {
                ...previousState,
                roomId,
                version,
                trackId: resolvedTrackId,
                playbackState: 'playing',
                basePositionMs: typeof startPositionMs === 'number' ? startPositionMs : 0,
                baseServerTimeMs: now,
                playbackRate: typeof playbackRate === 'number' ? playbackRate : 1,
                updatedByUserId: userId ?? null,
                updatedAt: now,
            };

            await RedisService.setRoomState(roomId, updatedState);

            await RedisService.publish(CONTROL_CHANNEL(roomId), {
                type: 'trackChanged',
                roomId,
                payload: {
                    trackId: resolvedTrackId,
                    startPositionMs: updatedState.basePositionMs,
                    serverTimeMs: now,
                    version,
                },
            });

            await publishStateUpdate(roomId, updatedState);

            return updatedState;
        } finally {
            if (typeof release === 'function') {
                await release().catch((error) => {
                    console.warn(`Failed to release lock for room ${roomId}`, error);
                });
            }
        }
    },
};
