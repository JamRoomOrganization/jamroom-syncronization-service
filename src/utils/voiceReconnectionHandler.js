/**
 * Voice Reconnection Handler
 * 
 * Manages voice state reconciliation when users reconnect.
 * Handles session recovery, state conflicts, and cleanup.
 * 
 * Features:
 * - Session recovery from chatVoice-service
 * - State reconciliation with local VoiceState
 * - Conflict resolution for stale sessions
 * - Graceful cleanup on permanent disconnects
 * 
 * @module voiceReconnectionHandler
 */

import { VoiceState } from '../voice/voiceState.js';
import {
    listVoiceSessionsByRoom,
    deleteVoiceSession,
    createOrUpdateVoiceSession,
} from '../services/voiceSessionsClient.js';
import { voiceServiceConfig } from '../config/voiceServiceConfig.js';

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Maximum time to consider a session as "recent" for reconciliation
 */
const SESSION_STALE_THRESHOLD_MS = 60000; // 1 minute

/**
 * Delay before cleaning up orphaned sessions
 */
const ORPHAN_CLEANUP_DELAY_MS = 5000;

// ============================================================================
// PENDING RECONNECTIONS
// ============================================================================

/**
 * @typedef {Object} PendingReconnection
 * @property {string} userId - User ID
 * @property {string} roomId - Room ID
 * @property {string} [sessionId] - Previous session ID if known
 * @property {number} disconnectTime - When user disconnected
 * @property {NodeJS.Timeout} [cleanupTimer] - Timer for orphan cleanup
 */

/**
 * Pending reconnections by `${roomId}:${userId}`
 * @type {Map<string, PendingReconnection>}
 */
const pendingReconnections = new Map();

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Marks a user as disconnected but potentially reconnecting
 * Sets up cleanup timer for orphaned sessions
 * 
 * @param {string} roomId - Room identifier
 * @param {string} userId - User identifier
 * @param {Object} [options]
 * @param {string} [options.sessionId] - Voice session ID
 * @param {string} [options.requestId] - Request ID for logging
 */
export function markDisconnected(roomId, userId, options = {}) {
    const key = `${roomId}:${userId}`;
    const { sessionId, requestId } = options;

    // Cancel existing cleanup timer if any
    const existing = pendingReconnections.get(key);
    if (existing?.cleanupTimer) {
        clearTimeout(existing.cleanupTimer);
    }

    const pending = {
        userId,
        roomId,
        sessionId,
        disconnectTime: Date.now(),
        cleanupTimer: null,
    };

    // Set up delayed cleanup for orphaned sessions
    if (sessionId) {
        pending.cleanupTimer = setTimeout(() => {
            handleOrphanedSession(roomId, userId, sessionId, requestId);
        }, ORPHAN_CLEANUP_DELAY_MS);
    }

    pendingReconnections.set(key, pending);

    console.log('[voice-reconnect] marked disconnected', {
        roomId,
        userId,
        sessionId,
        requestId,
    });
}

/**
 * Handles a user reconnecting to voice
 * Reconciles state with voice service and local state
 * 
 * @param {string} roomId - Room identifier
 * @param {string} userId - User identifier
 * @param {Object} [options]
 * @param {Object} [options.socket] - Socket for emitting events
 * @param {string} [options.requestId] - Request ID for logging
 * @returns {Promise<{ recovered: boolean; session?: Object; error?: string }>}
 */
export async function handleReconnection(roomId, userId, options = {}) {
    const key = `${roomId}:${userId}`;
    const { socket, requestId } = options;

    const pending = pendingReconnections.get(key);
    
    // Cancel cleanup timer
    if (pending?.cleanupTimer) {
        clearTimeout(pending.cleanupTimer);
        pending.cleanupTimer = null;
    }

    // Remove from pending
    pendingReconnections.delete(key);

    // If voice service is not available, just use local state
    if (!voiceServiceConfig.isAvailable) {
        console.warn('[voice-reconnect] voice service unavailable, using local state', {
            roomId,
            userId,
            requestId,
        });
        return { recovered: false, error: 'voice_service_unavailable' };
    }

    try {
        // Check if user still has an active session in voice service
        const sessions = await listVoiceSessionsByRoom(roomId, { 
            requestId, 
            noRetry: true,
        });

        const existingSession = sessions.find(s => s.userId === userId);

        if (existingSession) {
            // Session still exists - reconcile with local state
            const wasInVoice = VoiceState.getParticipant(roomId, userId);
            
            if (!wasInVoice) {
                // Re-add to local state
                VoiceState.joinVoice(roomId, userId, {
                    role: existingSession.role,
                    canPublishAudio: existingSession.canPublishAudio,
                });
                VoiceState.attachSession(roomId, userId, existingSession.sessionId);
            }

            console.log('[voice-reconnect] session recovered', {
                roomId,
                userId,
                sessionId: existingSession.sessionId,
                requestId,
            });

            return {
                recovered: true,
                session: existingSession,
            };
        }

        // No session in service - check local state
        const localParticipant = VoiceState.getParticipant(roomId, userId);
        
        if (localParticipant) {
            // Stale local state - clean it up
            VoiceState.leaveVoice(roomId, userId);
            console.log('[voice-reconnect] cleaned stale local state', {
                roomId,
                userId,
                requestId,
            });
        }

        return { recovered: false };
    } catch (error) {
        console.error('[voice-reconnect] reconciliation failed', {
            roomId,
            userId,
            error: error.message,
            requestId,
        });

        return { recovered: false, error: error.message };
    }
}

/**
 * Cleans up an orphaned session after disconnect timeout
 * 
 * @param {string} roomId
 * @param {string} userId
 * @param {string} sessionId
 * @param {string} [requestId]
 */
async function handleOrphanedSession(roomId, userId, sessionId, requestId) {
    const key = `${roomId}:${userId}`;
    
    // Remove from pending reconnections
    pendingReconnections.delete(key);

    // Clean local state
    VoiceState.leaveVoice(roomId, userId);

    // Delete session from voice service (best effort)
    if (sessionId && voiceServiceConfig.isAvailable) {
        try {
            await deleteVoiceSession(sessionId, { requestId });
            console.log('[voice-reconnect] orphaned session cleaned', {
                roomId,
                userId,
                sessionId,
                requestId,
            });
        } catch (error) {
            console.error('[voice-reconnect] failed to clean orphaned session', {
                roomId,
                userId,
                sessionId,
                error: error.message,
                requestId,
            });
        }
    }
}

/**
 * Reconciles local voice state with voice service for a room
 * Useful after server restart or state corruption
 * 
 * @param {string} roomId - Room identifier
 * @param {Object} [options]
 * @param {string} [options.requestId] - Request ID for logging
 * @returns {Promise<{ added: string[]; removed: string[] }>}
 */
export async function reconcileRoomState(roomId, options = {}) {
    const { requestId } = options;
    const result = { added: [], removed: [] };

    if (!voiceServiceConfig.isAvailable) {
        console.warn('[voice-reconnect] cannot reconcile - voice service unavailable', {
            roomId,
            requestId,
        });
        return result;
    }

    try {
        // Get sessions from voice service
        const remoteSessions = await listVoiceSessionsByRoom(roomId, { requestId });
        const remoteUserIds = new Set(remoteSessions.map(s => s.userId));

        // Get local state
        const localState = VoiceState.getVoiceState(roomId);
        const localUserIds = new Set(localState.participants.map(p => p.userId));

        // Find users in remote but not local (add to local)
        for (const session of remoteSessions) {
            if (!localUserIds.has(session.userId)) {
                VoiceState.joinVoice(roomId, session.userId, {
                    role: session.role,
                    canPublishAudio: session.canPublishAudio,
                });
                VoiceState.attachSession(roomId, session.userId, session.sessionId);
                result.added.push(session.userId);
            }
        }

        // Find users in local but not remote (remove from local)
        for (const participant of localState.participants) {
            if (!remoteUserIds.has(participant.userId)) {
                VoiceState.leaveVoice(roomId, participant.userId);
                result.removed.push(participant.userId);
            }
        }

        if (result.added.length > 0 || result.removed.length > 0) {
            console.log('[voice-reconnect] room state reconciled', {
                roomId,
                added: result.added,
                removed: result.removed,
                requestId,
            });
        }

        return result;
    } catch (error) {
        console.error('[voice-reconnect] room reconciliation failed', {
            roomId,
            error: error.message,
            requestId,
        });
        return result;
    }
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Checks if a user has a pending reconnection
 * 
 * @param {string} roomId
 * @param {string} userId
 * @returns {boolean}
 */
export function hasPendingReconnection(roomId, userId) {
    return pendingReconnections.has(`${roomId}:${userId}`);
}

/**
 * Gets the number of pending reconnections
 * @returns {number}
 */
export function getPendingReconnectionCount() {
    return pendingReconnections.size;
}

/**
 * Clears all pending reconnections (for testing)
 */
export function clearPendingReconnections() {
    for (const pending of pendingReconnections.values()) {
        if (pending.cleanupTimer) {
            clearTimeout(pending.cleanupTimer);
        }
    }
    pendingReconnections.clear();
}

/**
 * Forces cleanup of all pending reconnections
 * Useful for shutdown
 * 
 * @param {string} [requestId]
 */
export async function cleanupAllPending(requestId) {
    const pending = Array.from(pendingReconnections.entries());
    
    for (const [key, { roomId, userId, sessionId }] of pending) {
        await handleOrphanedSession(roomId, userId, sessionId, requestId);
    }
    
    pendingReconnections.clear();
}
