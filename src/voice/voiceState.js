/**
 * Voice State Management Module
 * 
 * Manages the voice channel state for each room in memory.
 * This is a placeholder for future WebRTC/audio integration.
 * 
 * Feature flag: JAMROOM_ENABLE_VOICE must be "true" for voice features to work.
 */

/**
 * @typedef {'host' | 'cohost' | 'speaker' | 'listener'} VoiceRole
 */

/**
 * @typedef {Object} VoiceParticipant
 * @property {string} userId - The user's unique identifier
 * @property {boolean} muted - Whether the user is self-muted (local mute)
 * @property {boolean} serverMuted - Whether the user is server-muted (moderation)
 * @property {VoiceRole} [role] - The user's role in the voice channel
 * @property {string} [sessionId] - Optional voice session ID from chatVoice-service
 * @property {boolean} [canPublishAudio] - Whether user can publish audio (from session)
 */

/**
 * @typedef {Object} RoomVoiceState
 * @property {string} roomId - The room's unique identifier
 * @property {Map<string, VoiceParticipant>} participants - Map of userId to participant info
 */

/**
 * In-memory storage for voice state per room
 * @type {Map<string, RoomVoiceState>}
 */
const voiceRooms = new Map();

/**
 * Ensures a room exists in the voice state
 * @param {string} roomId 
 * @returns {RoomVoiceState}
 */
const ensureRoom = (roomId) => {
    if (!voiceRooms.has(roomId)) {
        voiceRooms.set(roomId, {
            roomId,
            participants: new Map(),
        });
    }
    return voiceRooms.get(roomId);
};

/**
 * Validates roomId is a non-empty string
 * @param {string} roomId 
 * @returns {boolean}
 */
const isValidRoomId = (roomId) =>
    typeof roomId === 'string' && roomId.trim().length > 0;

/**
 * Validates userId is a non-empty string
 * @param {string} userId 
 * @returns {boolean}
 */
const isValidUserId = (userId) =>
    typeof userId === 'string' && userId.trim().length > 0;

/**
 * Adds a user to a room's voice channel
 * @param {string} roomId - The room identifier
 * @param {string} userId - The user identifier
 * @param {Object} [options] - Additional options
 * @param {VoiceRole} [options.role] - The user's role in the voice channel
 * @param {boolean} [options.canPublishAudio=true] - Whether user can publish audio
 * @returns {{ success: boolean; error?: string }}
 */
export function joinVoice(roomId, userId, { role, canPublishAudio = true } = {}) {
    if (!isValidRoomId(roomId)) {
        return { success: false, error: 'invalid_room_id' };
    }
    if (!isValidUserId(userId)) {
        return { success: false, error: 'invalid_user_id' };
    }

    const room = ensureRoom(roomId);
    
    // If user already exists, update their role if provided
    if (room.participants.has(userId)) {
        const participant = room.participants.get(userId);
        if (role) {
            participant.role = role;
        }
        if (canPublishAudio !== undefined) {
            participant.canPublishAudio = canPublishAudio;
        }
        return { success: true };
    }

    room.participants.set(userId, {
        userId,
        muted: false, // Default: unmuted when joining (self-mute)
        serverMuted: false, // Default: not server-muted
        role: role || undefined,
        canPublishAudio,
        sessionId: undefined, // Will be set via attachSession after voice service call
    });

    return { success: true };
}

/**
 * Removes a user from a room's voice channel
 * @param {string} roomId - The room identifier
 * @param {string} userId - The user identifier
 * @returns {{ success: boolean; error?: string }}
 */
export function leaveVoice(roomId, userId) {
    if (!isValidRoomId(roomId)) {
        return { success: false, error: 'invalid_room_id' };
    }
    if (!isValidUserId(userId)) {
        return { success: false, error: 'invalid_user_id' };
    }

    const room = voiceRooms.get(roomId);
    if (!room) {
        // Room doesn't exist, consider leave successful (idempotent)
        return { success: true };
    }

    room.participants.delete(userId);

    // Clean up empty rooms
    if (room.participants.size === 0) {
        voiceRooms.delete(roomId);
    }

    return { success: true };
}

/**
 * Sets the mute status for a user in a room's voice channel
 * @param {string} roomId - The room identifier
 * @param {string} userId - The user identifier
 * @param {boolean} muted - The mute status
 * @returns {{ success: boolean; error?: string }}
 */
export function setMute(roomId, userId, muted) {
    if (!isValidRoomId(roomId)) {
        return { success: false, error: 'invalid_room_id' };    
    }
    if (!isValidUserId(userId)) {
        return { success: false, error: 'invalid_user_id' };
    }
    if (typeof muted !== 'boolean') {
        return { success: false, error: 'invalid_muted_value' };
    }

    const room = voiceRooms.get(roomId);
    if (!room) {
        return { success: false, error: 'user_not_in_voice' };
    }

    const participant = room.participants.get(userId);
    if (!participant) {
        return { success: false, error: 'user_not_in_voice' };
    }

    participant.muted = muted;
    return { success: true };
}

/**
 * Gets the voice state for a room
 * @param {string} roomId - The room identifier
 * @returns {{ roomId: string; participants: Array<{ userId: string; muted: boolean; serverMuted: boolean; role?: VoiceRole; canPublishAudio?: boolean }> }}
 */
export function getVoiceState(roomId) {
    if (!isValidRoomId(roomId)) {
        return {
            roomId: roomId || '',
            participants: [],
        };
    }

    const room = voiceRooms.get(roomId);
    if (!room) {
        return {
            roomId,
            participants: [],
        };
    }

    const participants = Array.from(room.participants.values()).map(
        ({ userId, muted, serverMuted, role, canPublishAudio }) => ({
            userId,
            muted,
            serverMuted: serverMuted || false,
            ...(role && { role }),
            ...(canPublishAudio !== undefined && { canPublishAudio }),
        })
    );

    return {
        roomId,
        participants,
    };
}

/**
 * Clears all voice state (useful for testing)
 */
export function clearAllVoiceState() {
    voiceRooms.clear();
}

/**
 * Gets the number of active voice rooms (useful for metrics/debugging)
 * @returns {number}
 */
export function getActiveVoiceRoomCount() {
    return voiceRooms.size;
}

/**
 * Gets all room IDs where a user is currently in voice
 * @param {string} userId - The user identifier
 * @returns {string[]} Array of room IDs
 */
export function getRoomsForUser(userId) {
    if (!isValidUserId(userId)) {
        return [];
    }
    
    const rooms = [];
    for (const [roomId, room] of voiceRooms.entries()) {
        if (room.participants.has(userId)) {
            rooms.push(roomId);
        }
    }
    return rooms;
}

/**
 * Check if the voice feature is enabled
 * @returns {boolean}
 */
export function isVoiceEnabled() {
    return process.env.JAMROOM_ENABLE_VOICE === 'true';
}

/**
 * Check if voice media (getUserMedia/MediaStream) is enabled
 * This requires JAMROOM_ENABLE_VOICE to also be true
 * @returns {boolean}
 */
export function isVoiceMediaEnabled() {
    return isVoiceEnabled() && process.env.JAMROOM_ENABLE_VOICE_MEDIA === 'true';
}

/**
 * Attaches a voice session ID to a participant in a room
 * @param {string} roomId - The room identifier
 * @param {string} userId - The user identifier
 * @param {string} sessionId - The voice session ID from chatVoice-service
 * @returns {{ success: boolean; error?: string }}
 */
export function attachSession(roomId, userId, sessionId) {
    if (!isValidRoomId(roomId)) {
        return { success: false, error: 'invalid_room_id' };
    }
    if (!isValidUserId(userId)) {
        return { success: false, error: 'invalid_user_id' };
    }
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        return { success: false, error: 'invalid_session_id' };
    }

    const room = voiceRooms.get(roomId);
    if (!room) {
        return { success: false, error: 'room_not_found' };
    }

    const participant = room.participants.get(userId);
    if (!participant) {
        return { success: false, error: 'user_not_in_voice' };
    }

    participant.sessionId = sessionId;
    return { success: true };
}

/**
 * Gets the session ID for a user in a room
 * @param {string} roomId - The room identifier
 * @param {string} userId - The user identifier
 * @returns {string|undefined} The session ID or undefined if not found
 */
export function getSessionId(roomId, userId) {
    if (!isValidRoomId(roomId) || !isValidUserId(userId)) {
        return undefined;
    }

    const room = voiceRooms.get(roomId);
    if (!room) {
        return undefined;
    }

    const participant = room.participants.get(userId);
    return participant?.sessionId;
}

/**
 * Gets all sessions for a user across all rooms
 * @param {string} userId - The user identifier
 * @returns {Array<{ roomId: string; sessionId: string }>} Array of room and session info
 */
export function getSessionsForUser(userId) {
    if (!isValidUserId(userId)) {
        return [];
    }
    
    const sessions = [];
    for (const [roomId, room] of voiceRooms.entries()) {
        const participant = room.participants.get(userId);
        if (participant && participant.sessionId) {
            sessions.push({
                roomId,
                sessionId: participant.sessionId,
            });
        }
    }
    return sessions;
}

/**
 * Sets the server-muted status for a user (moderation)
 * @param {string} roomId - The room identifier
 * @param {string} userId - The user identifier
 * @param {boolean} serverMuted - The server-muted status
 * @returns {{ success: boolean; error?: string }}
 */
export function setServerMuted(roomId, userId, serverMuted) {
    if (!isValidRoomId(roomId)) {
        return { success: false, error: 'invalid_room_id' };
    }
    if (!isValidUserId(userId)) {
        return { success: false, error: 'invalid_user_id' };
    }
    if (typeof serverMuted !== 'boolean') {
        return { success: false, error: 'invalid_server_muted_value' };
    }

    const room = voiceRooms.get(roomId);
    if (!room) {
        return { success: false, error: 'room_not_found' };
    }

    const participant = room.participants.get(userId);
    if (!participant) {
        return { success: false, error: 'user_not_in_voice' };
    }

    participant.serverMuted = serverMuted;
    return { success: true };
}

/**
 * Sets the role for a user in voice
 * @param {string} roomId - The room identifier
 * @param {string} userId - The user identifier
 * @param {VoiceRole} role - The role to set
 * @returns {{ success: boolean; error?: string }}
 */
export function setRole(roomId, userId, role) {
    if (!isValidRoomId(roomId)) {
        return { success: false, error: 'invalid_room_id' };
    }
    if (!isValidUserId(userId)) {
        return { success: false, error: 'invalid_user_id' };
    }
    
    const validRoles = ['host', 'cohost', 'speaker', 'listener'];
    if (role && !validRoles.includes(role)) {
        return { success: false, error: 'invalid_role' };
    }

    const room = voiceRooms.get(roomId);
    if (!room) {
        return { success: false, error: 'room_not_found' };
    }

    const participant = room.participants.get(userId);
    if (!participant) {
        return { success: false, error: 'user_not_in_voice' };
    }

    participant.role = role || undefined;
    return { success: true };
}

/**
 * Gets a specific participant's info
 * @param {string} roomId - The room identifier
 * @param {string} userId - The user identifier
 * @returns {VoiceParticipant | null}
 */
export function getParticipant(roomId, userId) {
    if (!isValidRoomId(roomId) || !isValidUserId(userId)) {
        return null;
    }

    const room = voiceRooms.get(roomId);
    if (!room) {
        return null;
    }

    const participant = room.participants.get(userId);
    if (!participant) {
        return null;
    }

    return {
        userId: participant.userId,
        muted: participant.muted,
        serverMuted: participant.serverMuted || false,
        role: participant.role,
        sessionId: participant.sessionId,
        canPublishAudio: participant.canPublishAudio,
    };
}

/**
 * Updates the canPublishAudio flag for a participant
 * @param {string} roomId - The room identifier
 * @param {string} userId - The user identifier
 * @param {boolean} canPublishAudio - Whether user can publish audio
 * @returns {{ success: boolean; error?: string }}
 */
export function setCanPublishAudio(roomId, userId, canPublishAudio) {
    if (!isValidRoomId(roomId)) {
        return { success: false, error: 'invalid_room_id' };
    }
    if (!isValidUserId(userId)) {
        return { success: false, error: 'invalid_user_id' };
    }
    if (typeof canPublishAudio !== 'boolean') {
        return { success: false, error: 'invalid_can_publish_audio_value' };
    }

    const room = voiceRooms.get(roomId);
    if (!room) {
        return { success: false, error: 'room_not_found' };
    }

    const participant = room.participants.get(userId);
    if (!participant) {
        return { success: false, error: 'user_not_in_voice' };
    }

    participant.canPublishAudio = canPublishAudio;
    return { success: true };
}

/**
 * Counts speakers (participants with canPublishAudio = true) in a room
 * @param {string} roomId - The room identifier
 * @returns {number}
 */
export function countSpeakers(roomId) {
    if (!isValidRoomId(roomId)) {
        return 0;
    }

    const room = voiceRooms.get(roomId);
    if (!room) {
        return 0;
    }

    let count = 0;
    for (const participant of room.participants.values()) {
        if (participant.canPublishAudio) {
            count++;
        }
    }
    return count;
}

export const VoiceState = {
    joinVoice,
    leaveVoice,
    setMute,
    getVoiceState,
    clearAllVoiceState,
    getActiveVoiceRoomCount,
    getRoomsForUser,
    isVoiceEnabled,
    isVoiceMediaEnabled,
    attachSession,
    getSessionId,
    getSessionsForUser,
    // New moderation functions
    setServerMuted,
    setRole,
    getParticipant,
    setCanPublishAudio,
    countSpeakers,
};
