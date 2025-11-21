const rooms = new Map();
const MAX_DRIFT_SAMPLES = 100;

const ensureRoom = (roomId) => {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            users: new Set(),
            drifts: [],
            seeks: 0,
            rates: 0,
            lastAt: Date.now(),
        });
    }
    return rooms.get(roomId);
};

const updateLastAt = (room) => {
    room.lastAt = Date.now();
};

const calculateP95 = (values) => {
    if (!values.length) {
        return 0;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(
        sorted.length - 1,
        Math.floor(0.95 * (sorted.length - 1)),
    );
    return sorted[index];
};

export const Metrics = {
    userJoin(roomId, userId) {
        if (!roomId) {
            return;
        }
        const room = ensureRoom(roomId);
        if (userId) {
            room.users.add(String(userId));
        }
        updateLastAt(room);
    },

    userLeave(roomId, userId) {
        if (!roomId || !rooms.has(roomId)) {
            return;
        }
        const room = rooms.get(roomId);
        if (userId) {
            room.users.delete(String(userId));
        }
        updateLastAt(room);
    },

    recordDrift(roomId, driftMs) {
        if (!roomId) {
            return;
        }
        const room = ensureRoom(roomId);
        if (typeof driftMs === 'number' && Number.isFinite(driftMs)) {
            room.drifts.push(Math.abs(driftMs));
            if (room.drifts.length > MAX_DRIFT_SAMPLES) {
                room.drifts.splice(0, room.drifts.length - MAX_DRIFT_SAMPLES);
            }
        }
        updateLastAt(room);
    },

    recordSeek(roomId) {
        if (!roomId) {
            return;
        }
        const room = ensureRoom(roomId);
        room.seeks += 1;
        updateLastAt(room);
    },

    recordRateAdjust(roomId) {
        if (!roomId) {
            return;
        }
        const room = ensureRoom(roomId);
        room.rates += 1;
        updateLastAt(room);
    },

    snapshotRoom(roomId) {
        if (!roomId || !rooms.has(roomId)) {
            return null;
        }
        const room = rooms.get(roomId);
        return {
            roomId,
            users: Array.from(room.users),
            driftSamples: room.drifts.length,
            driftP95Ms: calculateP95(room.drifts),
            rateAdjusts: room.rates,
            seeks: room.seeks,
            lastAt: room.lastAt,
        };
    },
};
