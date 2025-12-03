/**
 * Integration tests for Voice Moderation Socket.IO handlers
 * 
 * These tests verify the voice:host-mute, voice:host-unmute, voice:host-kick events
 * and room policies (maxSpeakers, hostOnlyMode) work correctly.
 * 
 * Tests cover:
 * - voice:host-mute with proper permissions
 * - voice:host-mute without permissions
 * - voice:host-unmute with proper permissions
 * - voice:host-kick with proper permissions
 * - maxSpeakers policy enforcement
 * - hostOnlyMode policy enforcement
 */

import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioc } from 'socket.io-client';
import * as VoiceState from './voiceState.js';

// Set the feature flag to enable voice
process.env.JAMROOM_ENABLE_VOICE = 'true';

const ENABLE_VOICE = process.env.JAMROOM_ENABLE_VOICE === 'true';
const roomChannel = (roomId) => `room:${roomId}`;

const isValidRoomId = (roomId) =>
    typeof roomId === 'string' && roomId.trim().length > 0;

// Mock state - controlled per test
let mockState = {
    // Auth mock
    authResponse: { userId: 'host-user', roles: ['host'] },
    authError: null,
    // Service mocks
    serverMuteError: null,
    serverUnmuteError: null,
    kickError: null,
    createSessionError: null,
    // Room policy
    roomPolicy: { maxSpeakers: null, hostOnlyMode: false },
};

// Track service calls for assertions
let serviceCalls = {
    serverMute: [],
    serverUnmute: [],
    kick: [],
    createSession: [],
    getRoomPolicy: [],
};

/**
 * Reset all mock state
 */
function resetMocks() {
    mockState = {
        authResponse: { userId: 'host-user', roles: ['host'] },
        authError: null,
        serverMuteError: null,
        serverUnmuteError: null,
        kickError: null,
        createSessionError: null,
        roomPolicy: { maxSpeakers: null, hostOnlyMode: false },
    };
    serviceCalls = {
        serverMute: [],
        serverUnmute: [],
        kick: [],
        createSession: [],
        getRoomPolicy: [],
    };
}

/**
 * Test server that implements moderation handlers with mock dependencies
 */
function createModerationTestServer() {
    const httpServer = createServer();
    const io = new SocketIOServer(httpServer, {
        cors: { origin: '*' },
    });

    io.on('connection', (socket) => {
        socket.userId = socket.handshake.auth?.userId || `user-${socket.id}`;
        socket.data = socket.handshake.auth?.data || {};
        socket.joinedRooms = new Set();

        socket.on('joinRoom', ({ roomId } = {}) => {
            if (!isValidRoomId(roomId)) return;
            socket.join(roomChannel(roomId));
            socket.joinedRooms.add(roomId);
        });

        socket.on('leaveRoom', ({ roomId } = {}) => {
            if (!isValidRoomId(roomId)) return;
            socket.leave(roomChannel(roomId));
            socket.joinedRooms.delete(roomId);
        });

        // ========== voice:join with policy checks ==========
        if (ENABLE_VOICE) {
            socket.on('voice:join', async ({ roomId, userId: payloadUserId } = {}) => {
                if (!isValidRoomId(roomId)) {
                    socket.emit('voice:error', { action: 'join', error: 'invalid_room_id' });
                    return;
                }

                if (!socket.joinedRooms.has(roomId)) {
                    socket.emit('voice:error', { action: 'join', roomId, error: 'not_in_room' });
                    return;
                }

                const effectiveUserId = payloadUserId || socket.userId;
                
                // Determine user's role based on mock auth state
                let userRole = 'speaker';
                let isHost = false;
                
                if (!mockState.authError) {
                    isHost = true;
                    userRole = 'host';
                } else {
                    isHost = false;
                    userRole = 'speaker';
                }
                
                // Fetch room policy (mocked)
                serviceCalls.getRoomPolicy.push({ roomId });
                const roomPolicy = mockState.roomPolicy;
                
                // Check hostOnlyMode
                let canPublishAudio = true;
                
                if (roomPolicy.hostOnlyMode && !isHost) {
                    canPublishAudio = false;
                    userRole = 'listener';
                }
                
                // Check maxSpeakers limit
                if (canPublishAudio && roomPolicy.maxSpeakers !== null && !isHost) {
                    const currentSpeakers = VoiceState.countSpeakers(roomId);
                    
                    if (currentSpeakers >= roomPolicy.maxSpeakers) {
                        canPublishAudio = false;
                        userRole = 'listener';
                    }
                }

                // Create voice session (mocked)
                if (mockState.createSessionError) {
                    socket.emit('voice:error', { action: 'join', roomId, error: 'voice_service_error' });
                    return;
                }
                
                serviceCalls.createSession.push({
                    roomId,
                    userId: effectiveUserId,
                    canPublishAudio,
                });

                const result = VoiceState.joinVoice(roomId, effectiveUserId, {
                    role: userRole,
                    canPublishAudio,
                });

                if (!result.success) {
                    socket.emit('voice:error', { action: 'join', roomId, error: result.error });
                    return;
                }

                const voiceState = VoiceState.getVoiceState(roomId);
                io.to(roomChannel(roomId)).emit('voice:state', voiceState);
                
                // Emit voice:joined for the joining user
                socket.emit('voice:joined', {
                    roomId,
                    userId: effectiveUserId,
                    role: userRole,
                    canPublishAudio,
                    sessionId: `session-${effectiveUserId}`,
                    token: 'mock-token',
                });
            });

            // ========== voice:host-mute ==========
            socket.on('voice:host-mute', async ({ roomId, targetUserId, reason } = {}) => {
                if (!isValidRoomId(roomId)) {
                    socket.emit('voice:error', { action: 'host-mute', error: 'invalid_room_id' });
                    return;
                }
                
                if (!targetUserId || typeof targetUserId !== 'string') {
                    socket.emit('voice:error', { action: 'host-mute', roomId, error: 'invalid_target_user_id' });
                    return;
                }
                
                // Validate target is in voice
                const targetParticipant = VoiceState.getParticipant(roomId, targetUserId);
                if (!targetParticipant) {
                    socket.emit('voice:error', { action: 'host-mute', roomId, error: 'target_not_in_voice' });
                    return;
                }
                
                // Check host/cohost permission (mocked)
                if (mockState.authError) {
                    socket.emit('voice:error', { action: 'host-mute', roomId, error: 'permission_denied' });
                    return;
                }
                
                const moderatorUserId = mockState.authResponse?.userId || socket.userId;
                
                // Call chatVoice-service (mocked)
                if (mockState.serverMuteError) {
                    socket.emit('voice:error', { action: 'host-mute', roomId, error: 'voice_service_error' });
                    return;
                }
                
                serviceCalls.serverMute.push({ roomId, targetUserId, moderatorUserId, reason });
                
                // Update local voice state
                const result = VoiceState.setServerMuted(roomId, targetUserId, true);
                
                if (!result.success) {
                    socket.emit('voice:error', { action: 'host-mute', roomId, error: result.error });
                    return;
                }
                
                const voiceState = VoiceState.getVoiceState(roomId);
                
                // Emit updated voice state
                io.to(roomChannel(roomId)).emit('voice:state', voiceState);
                
                // Emit moderation event
                io.to(roomChannel(roomId)).emit('voice:moderation', {
                    action: 'server-muted',
                    roomId,
                    targetUserId,
                    moderatorUserId,
                    reason,
                });
            });

            // ========== voice:host-unmute ==========
            socket.on('voice:host-unmute', async ({ roomId, targetUserId } = {}) => {
                if (!isValidRoomId(roomId)) {
                    socket.emit('voice:error', { action: 'host-unmute', error: 'invalid_room_id' });
                    return;
                }
                
                if (!targetUserId || typeof targetUserId !== 'string') {
                    socket.emit('voice:error', { action: 'host-unmute', roomId, error: 'invalid_target_user_id' });
                    return;
                }
                
                // Validate target is in voice
                const targetParticipant = VoiceState.getParticipant(roomId, targetUserId);
                if (!targetParticipant) {
                    socket.emit('voice:error', { action: 'host-unmute', roomId, error: 'target_not_in_voice' });
                    return;
                }
                
                // Check host/cohost permission (mocked)
                if (mockState.authError) {
                    socket.emit('voice:error', { action: 'host-unmute', roomId, error: 'permission_denied' });
                    return;
                }
                
                const moderatorUserId = mockState.authResponse?.userId || socket.userId;
                
                // Call chatVoice-service (mocked)
                if (mockState.serverUnmuteError) {
                    socket.emit('voice:error', { action: 'host-unmute', roomId, error: 'voice_service_error' });
                    return;
                }
                
                serviceCalls.serverUnmute.push({ roomId, targetUserId, moderatorUserId });
                
                // Update local voice state
                const result = VoiceState.setServerMuted(roomId, targetUserId, false);
                
                if (!result.success) {
                    socket.emit('voice:error', { action: 'host-unmute', roomId, error: result.error });
                    return;
                }
                
                const voiceState = VoiceState.getVoiceState(roomId);
                
                // Emit updated voice state
                io.to(roomChannel(roomId)).emit('voice:state', voiceState);
                
                // Emit moderation event
                io.to(roomChannel(roomId)).emit('voice:moderation', {
                    action: 'server-unmuted',
                    roomId,
                    targetUserId,
                    moderatorUserId,
                });
            });

            // ========== voice:host-kick ==========
            socket.on('voice:host-kick', async ({ roomId, targetUserId, reason } = {}) => {
                if (!isValidRoomId(roomId)) {
                    socket.emit('voice:error', { action: 'host-kick', error: 'invalid_room_id' });
                    return;
                }
                
                if (!targetUserId || typeof targetUserId !== 'string') {
                    socket.emit('voice:error', { action: 'host-kick', roomId, error: 'invalid_target_user_id' });
                    return;
                }
                
                // Validate target is in voice
                const targetParticipant = VoiceState.getParticipant(roomId, targetUserId);
                if (!targetParticipant) {
                    socket.emit('voice:error', { action: 'host-kick', roomId, error: 'target_not_in_voice' });
                    return;
                }
                
                // Check host/cohost permission (mocked)
                if (mockState.authError) {
                    socket.emit('voice:error', { action: 'host-kick', roomId, error: 'permission_denied' });
                    return;
                }
                
                const moderatorUserId = mockState.authResponse?.userId || socket.userId;
                
                // Get session ID before kicking
                const sessionId = VoiceState.getSessionId(roomId, targetUserId);
                
                // Call chatVoice-service (mocked)
                if (mockState.kickError) {
                    socket.emit('voice:error', { action: 'host-kick', roomId, error: 'voice_service_error' });
                    return;
                }
                
                serviceCalls.kick.push({ roomId, targetUserId, sessionId, moderatorUserId, reason });
                
                // Update local voice state
                const result = VoiceState.leaveVoice(roomId, targetUserId);
                
                if (!result.success) {
                    socket.emit('voice:error', { action: 'host-kick', roomId, error: result.error });
                    return;
                }
                
                const voiceState = VoiceState.getVoiceState(roomId);
                
                // Emit updated voice state
                io.to(roomChannel(roomId)).emit('voice:state', voiceState);
                
                // Emit moderation event
                io.to(roomChannel(roomId)).emit('voice:moderation', {
                    action: 'kicked',
                    roomId,
                    targetUserId,
                    moderatorUserId,
                    reason,
                });
            });
        }

        socket.on('disconnect', () => {
            if (ENABLE_VOICE) {
                const voiceRooms = VoiceState.getRoomsForUser(socket.userId);
                for (const roomId of voiceRooms) {
                    const leaveResult = VoiceState.leaveVoice(roomId, socket.userId);
                    if (leaveResult.success) {
                        const voiceState = VoiceState.getVoiceState(roomId);
                        io.to(roomChannel(roomId)).emit('voice:state', voiceState);
                    }
                }
            }
            socket.joinedRooms.clear();
        });
    });

    return { httpServer, io };
}

describe('Voice Moderation Integration Tests', () => {
    let httpServer;
    let io;
    let port;

    beforeEach(async () => {
        VoiceState.clearAllVoiceState();
        resetMocks();
        
        const server = createModerationTestServer();
        httpServer = server.httpServer;
        io = server.io;
        
        await new Promise((resolve) => {
            httpServer.listen(0, () => {
                port = httpServer.address().port;
                resolve();
            });
        });
    });

    afterEach(async () => {
        await new Promise((resolve) => {
            io.close(() => {
                httpServer.close(resolve);
            });
        });
    });

    const createClient = (userId = 'test-user') => {
        return ioc(`http://localhost:${port}`, {
            auth: { userId },
            transports: ['websocket'],
            forceNew: true,
        });
    };

    const waitForEvent = (socket, event, timeout = 2000) => {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`Timeout waiting for event: ${event}`));
            }, timeout);
            socket.once(event, (data) => {
                clearTimeout(timer);
                resolve(data);
            });
        });
    };

    const connectAndJoinRoom = async (client, roomId) => {
        await new Promise((resolve) => client.on('connect', resolve));
        client.emit('joinRoom', { roomId });
        await new Promise((resolve) => setTimeout(resolve, 50));
    };

    // =========================================================================
    // voice:host-mute tests
    // =========================================================================

    describe('voice:host-mute', () => {
        it('should server-mute user when host has permissions', async () => {
            const hostClient = createClient('host-user');
            const roomId = 'room-1';
            
            await connectAndJoinRoom(hostClient, roomId);
            
            // Add target user directly to voice state (simulating they joined earlier)
            VoiceState.joinVoice(roomId, 'target-user');
            
            // Host mutes the target
            const moderationPromise = waitForEvent(hostClient, 'voice:moderation');
            const statePromise = waitForEvent(hostClient, 'voice:state');
            
            hostClient.emit('voice:host-mute', {
                roomId,
                targetUserId: 'target-user',
                reason: 'Being disruptive',
            });
            
            const [moderation, state] = await Promise.all([moderationPromise, statePromise]);
            
            // Verify moderation event
            expect(moderation.action).toBe('server-muted');
            expect(moderation.roomId).toBe(roomId);
            expect(moderation.targetUserId).toBe('target-user');
            expect(moderation.moderatorUserId).toBe('host-user');
            expect(moderation.reason).toBe('Being disruptive');
            
            // Verify state was updated
            const targetParticipant = state.participants.find(p => p.userId === 'target-user');
            expect(targetParticipant.serverMuted).toBe(true);
            
            // Verify chatVoice-service was called
            expect(serviceCalls.serverMute.length).toBe(1);
            expect(serviceCalls.serverMute[0].roomId).toBe(roomId);
            expect(serviceCalls.serverMute[0].targetUserId).toBe('target-user');
            
            hostClient.disconnect();
        });

        it('should emit error when user does not have permissions', async () => {
            // Set auth error to simulate non-host
            mockState.authError = new Error('Forbidden');
            
            const regularClient = createClient('regular-user');
            const roomId = 'room-1';
            
            await connectAndJoinRoom(regularClient, roomId);
            
            // First add a target user directly to voice state (simulating they joined earlier)
            VoiceState.joinVoice(roomId, 'target-user');
            
            // Regular user tries to mute
            const errorPromise = waitForEvent(regularClient, 'voice:error');
            
            regularClient.emit('voice:host-mute', {
                roomId,
                targetUserId: 'target-user',
            });
            
            const error = await errorPromise;
            
            expect(error.action).toBe('host-mute');
            expect(error.error).toBe('permission_denied');
            
            // Verify chatVoice-service was NOT called
            expect(serviceCalls.serverMute.length).toBe(0);
            
            regularClient.disconnect();
        });

        it('should emit error when target user is not in voice', async () => {
            const hostClient = createClient('host-user');
            const roomId = 'room-1';
            
            await connectAndJoinRoom(hostClient, roomId);
            
            const errorPromise = waitForEvent(hostClient, 'voice:error');
            
            hostClient.emit('voice:host-mute', {
                roomId,
                targetUserId: 'non-existent-user',
            });
            
            const error = await errorPromise;
            
            expect(error.action).toBe('host-mute');
            expect(error.error).toBe('target_not_in_voice');
            
            // Verify chatVoice-service was NOT called
            expect(serviceCalls.serverMute.length).toBe(0);
            
            hostClient.disconnect();
        });

        it('should emit error when chatVoice-service fails', async () => {
            mockState.serverMuteError = new Error('Service unavailable');
            
            const hostClient = createClient('host-user');
            const roomId = 'room-1';
            
            await connectAndJoinRoom(hostClient, roomId);
            
            // Add target user directly
            VoiceState.joinVoice(roomId, 'target-user');
            
            const errorPromise = waitForEvent(hostClient, 'voice:error');
            
            hostClient.emit('voice:host-mute', {
                roomId,
                targetUserId: 'target-user',
            });
            
            const error = await errorPromise;
            
            expect(error.action).toBe('host-mute');
            expect(error.error).toBe('voice_service_error');
            
            hostClient.disconnect();
        });
    });

    // =========================================================================
    // voice:host-unmute tests
    // =========================================================================

    describe('voice:host-unmute', () => {
        it('should server-unmute user when host has permissions', async () => {
            const hostClient = createClient('host-user');
            const roomId = 'room-1';
            
            await connectAndJoinRoom(hostClient, roomId);
            
            // Add target user and server-mute them directly
            VoiceState.joinVoice(roomId, 'target-user');
            VoiceState.setServerMuted(roomId, 'target-user', true);
            
            // Unmute
            const moderationPromise = waitForEvent(hostClient, 'voice:moderation');
            
            hostClient.emit('voice:host-unmute', { roomId, targetUserId: 'target-user' });
            
            const moderation = await moderationPromise;
            
            expect(moderation.action).toBe('server-unmuted');
            expect(moderation.targetUserId).toBe('target-user');
            
            // Verify chatVoice-service was called
            expect(serviceCalls.serverUnmute.length).toBe(1);
            
            // Verify state
            const participant = VoiceState.getParticipant(roomId, 'target-user');
            expect(participant.serverMuted).toBe(false);
            
            hostClient.disconnect();
        });

        it('should emit error when user does not have permissions', async () => {
            mockState.authError = new Error('Forbidden');
            
            const regularClient = createClient('regular-user');
            const roomId = 'room-1';
            
            await connectAndJoinRoom(regularClient, roomId);
            
            // Add target user directly
            VoiceState.joinVoice(roomId, 'target-user');
            VoiceState.setServerMuted(roomId, 'target-user', true);
            
            const errorPromise = waitForEvent(regularClient, 'voice:error');
            
            regularClient.emit('voice:host-unmute', {
                roomId,
                targetUserId: 'target-user',
            });
            
            const error = await errorPromise;
            
            expect(error.action).toBe('host-unmute');
            expect(error.error).toBe('permission_denied');
            
            regularClient.disconnect();
        });
    });

    // =========================================================================
    // voice:host-kick tests
    // =========================================================================

    describe('voice:host-kick', () => {
        it('should kick user from voice when host has permissions', async () => {
            const hostClient = createClient('host-user');
            const roomId = 'room-1';
            
            await connectAndJoinRoom(hostClient, roomId);
            
            // Add target user directly
            VoiceState.joinVoice(roomId, 'target-user');
            
            // Host kicks the target
            const moderationPromise = waitForEvent(hostClient, 'voice:moderation');
            const statePromise = waitForEvent(hostClient, 'voice:state');
            
            hostClient.emit('voice:host-kick', {
                roomId,
                targetUserId: 'target-user',
                reason: 'Violation of rules',
            });
            
            const [moderation, state] = await Promise.all([moderationPromise, statePromise]);
            
            // Verify moderation event
            expect(moderation.action).toBe('kicked');
            expect(moderation.targetUserId).toBe('target-user');
            expect(moderation.reason).toBe('Violation of rules');
            
            // Verify user was removed from voice
            const targetParticipant = state.participants.find(p => p.userId === 'target-user');
            expect(targetParticipant).toBeUndefined();
            
            // Verify chatVoice-service was called
            expect(serviceCalls.kick.length).toBe(1);
            
            hostClient.disconnect();
        });

        it('should emit error when user does not have permissions', async () => {
            mockState.authError = new Error('Forbidden');
            
            const regularClient = createClient('regular-user');
            const roomId = 'room-1';
            
            await connectAndJoinRoom(regularClient, roomId);
            
            // Add target user directly
            VoiceState.joinVoice(roomId, 'target-user');
            
            const errorPromise = waitForEvent(regularClient, 'voice:error');
            
            regularClient.emit('voice:host-kick', {
                roomId,
                targetUserId: 'target-user',
            });
            
            const error = await errorPromise;
            
            expect(error.action).toBe('host-kick');
            expect(error.error).toBe('permission_denied');
            
            regularClient.disconnect();
        });
    });

    // =========================================================================
    // Room Policy tests - maxSpeakers
    // =========================================================================

    describe('maxSpeakers policy', () => {
        it('should allow user to join as speaker when under maxSpeakers limit', async () => {
            mockState.roomPolicy = { maxSpeakers: 5, hostOnlyMode: false };
            
            const client = createClient('user-1');
            const roomId = 'room-1';
            
            await connectAndJoinRoom(client, roomId);
            
            const joinedPromise = waitForEvent(client, 'voice:joined');
            client.emit('voice:join', { roomId });
            
            const joined = await joinedPromise;
            
            expect(joined.canPublishAudio).toBe(true);
            expect(joined.role).not.toBe('listener');
            
            // Verify createOrUpdateVoiceSession was called with canPublishAudio=true
            expect(serviceCalls.createSession.length).toBe(1);
            expect(serviceCalls.createSession[0].canPublishAudio).toBe(true);
            
            client.disconnect();
        });

        it('should make non-host user join as listener when maxSpeakers limit is reached', async () => {
            mockState.roomPolicy = { maxSpeakers: 2, hostOnlyMode: false };
            mockState.authError = new Error('Not host'); // Simulate non-host user
            
            // First, add existing speakers to reach the limit
            VoiceState.joinVoice('room-1', 'speaker-1', { role: 'speaker', canPublishAudio: true });
            VoiceState.joinVoice('room-1', 'speaker-2', { role: 'speaker', canPublishAudio: true });
            
            const client = createClient('new-user');
            const roomId = 'room-1';
            
            await connectAndJoinRoom(client, roomId);
            
            const joinedPromise = waitForEvent(client, 'voice:joined');
            client.emit('voice:join', { roomId });
            
            const joined = await joinedPromise;
            
            // Should join as listener since limit is reached
            expect(joined.canPublishAudio).toBe(false);
            expect(joined.role).toBe('listener');
            
            // Verify createOrUpdateVoiceSession was called with canPublishAudio=false
            expect(serviceCalls.createSession.length).toBe(1);
            expect(serviceCalls.createSession[0].canPublishAudio).toBe(false);
            
            client.disconnect();
        });

        it('should allow host to join as speaker even when maxSpeakers limit is reached', async () => {
            mockState.roomPolicy = { maxSpeakers: 2, hostOnlyMode: false };
            // Host has no auth error
            mockState.authError = null;
            mockState.authResponse = { userId: 'host-user', roles: ['host'] };
            
            // First, add existing speakers to reach the limit
            VoiceState.joinVoice('room-1', 'speaker-1', { role: 'speaker', canPublishAudio: true });
            VoiceState.joinVoice('room-1', 'speaker-2', { role: 'speaker', canPublishAudio: true });
            
            const hostClient = createClient('host-user');
            const roomId = 'room-1';
            
            await connectAndJoinRoom(hostClient, roomId);
            
            const joinedPromise = waitForEvent(hostClient, 'voice:joined');
            hostClient.emit('voice:join', { roomId });
            
            const joined = await joinedPromise;
            
            // Host should be able to speak (not limited by maxSpeakers)
            expect(joined.canPublishAudio).toBe(true);
            expect(joined.role).toBe('host');
            
            hostClient.disconnect();
        });
    });

    // =========================================================================
    // Room Policy tests - hostOnlyMode
    // =========================================================================

    describe('hostOnlyMode policy', () => {
        it('should make non-host join as listener when hostOnlyMode is active', async () => {
            mockState.roomPolicy = { maxSpeakers: null, hostOnlyMode: true };
            mockState.authError = new Error('Not host'); // Simulate non-host user
            
            const client = createClient('regular-user');
            const roomId = 'room-1';
            
            await connectAndJoinRoom(client, roomId);
            
            const joinedPromise = waitForEvent(client, 'voice:joined');
            client.emit('voice:join', { roomId });
            
            const joined = await joinedPromise;
            
            expect(joined.canPublishAudio).toBe(false);
            expect(joined.role).toBe('listener');
            
            // Verify createOrUpdateVoiceSession was called with canPublishAudio=false
            expect(serviceCalls.createSession.length).toBe(1);
            expect(serviceCalls.createSession[0].canPublishAudio).toBe(false);
            
            client.disconnect();
        });

        it('should allow host to speak when hostOnlyMode is active', async () => {
            mockState.roomPolicy = { maxSpeakers: null, hostOnlyMode: true };
            mockState.authError = null; // Host has no auth error
            mockState.authResponse = { userId: 'host-user', roles: ['host'] };
            
            const hostClient = createClient('host-user');
            const roomId = 'room-1';
            
            await connectAndJoinRoom(hostClient, roomId);
            
            const joinedPromise = waitForEvent(hostClient, 'voice:joined');
            hostClient.emit('voice:join', { roomId });
            
            const joined = await joinedPromise;
            
            expect(joined.canPublishAudio).toBe(true);
            expect(joined.role).toBe('host');
            
            hostClient.disconnect();
        });

        it('should allow regular user to speak when hostOnlyMode is false', async () => {
            mockState.roomPolicy = { maxSpeakers: null, hostOnlyMode: false };
            mockState.authError = new Error('Not host'); // Non-host but hostOnlyMode is false
            
            const client = createClient('regular-user');
            const roomId = 'room-1';
            
            await connectAndJoinRoom(client, roomId);
            
            const joinedPromise = waitForEvent(client, 'voice:joined');
            client.emit('voice:join', { roomId });
            
            const joined = await joinedPromise;
            
            // Regular user should be able to speak when hostOnlyMode is false
            expect(joined.canPublishAudio).toBe(true);
            expect(joined.role).toBe('speaker');
            
            client.disconnect();
        });
    });
});
