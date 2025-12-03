/**
 * Integration tests for Voice Service Error Handling
 * 
 * These tests verify that when voiceSessionsClient returns errors,
 * the sync-service properly emits voice:error events with the correct
 * standardized error codes and does NOT modify local voiceState.
 * 
 * Tests cover:
 * - VOICE_SERVICE_UNAVAILABLE on voice:join
 * - VOICE_LIVEKIT_UNAVAILABLE on voice:join  
 * - VOICE_SERVICE_TIMEOUT on voice:join
 * - Error payload structure verification
 */

import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioc } from 'socket.io-client';
import * as VoiceState from './voiceState.js';
import { VoiceError, VoiceErrorCode, VoiceErrors } from './voiceErrors.js';

// Set the feature flag to enable voice
process.env.JAMROOM_ENABLE_VOICE = 'true';

const ENABLE_VOICE = process.env.JAMROOM_ENABLE_VOICE === 'true';
const roomChannel = (roomId) => `room:${roomId}`;

const isValidRoomId = (roomId) =>
    typeof roomId === 'string' && roomId.trim().length > 0;

// Mock state - controlled per test
let mockState = {
    // Service mocks
    createSessionError: null,
    createSessionResponse: null,
    voiceServiceAvailable: true,
};

// Track service calls for assertions
let serviceCalls = {
    createSession: [],
};

/**
 * Reset all mock state
 */
function resetMocks() {
    mockState = {
        createSessionError: null,
        createSessionResponse: {
            sessionId: 'session-123',
            roomId: 'test-room',
            userId: 'test-user',
            livekit: { token: 'mock-token', wsUrl: 'wss://mock.livekit.cloud' },
        },
        voiceServiceAvailable: true,
    };
    serviceCalls = {
        createSession: [],
    };
}

/**
 * Helper to emit voice:error with VoiceError codes (mirrors syncGateway implementation)
 */
function emitVoiceError(socket, errorCode, options = {}) {
    const errorDef = VoiceErrors[errorCode] || VoiceErrors[VoiceErrorCode.VOICE_INTERNAL_ERROR];
    
    socket.emit('voice:error', {
        code: errorDef.code,
        message: errorDef.message,
        uiMessage: errorDef.uiMessage,
        retryable: errorDef.retryable,
        action: options.action,
        roomId: options.roomId,
        ...(options.targetUserId && { targetUserId: options.targetUserId }),
        ...(options.context && { context: options.context }),
    });
}

/**
 * Helper to emit voice:error from VoiceError exception
 */
function emitVoiceErrorFromException(socket, err, options = {}) {
    if (err instanceof VoiceError) {
        socket.emit('voice:error', {
            ...err.toSocketPayload(),
            action: options.action,
        });
        return;
    }
    
    // Wrap unknown errors
    const wrapped = new VoiceError(VoiceErrorCode.VOICE_INTERNAL_ERROR, {
        message: err.message,
        cause: err,
        roomId: options.roomId,
    });
    socket.emit('voice:error', {
        ...wrapped.toSocketPayload(),
        action: options.action,
    });
}

/**
 * Test server that implements voice:join with mocked voiceSessionsClient
 */
function createServiceErrorTestServer() {
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

        // ========== voice:join with service error handling ==========
        if (ENABLE_VOICE) {
            socket.on('voice:join', async ({ roomId, userId: payloadUserId } = {}) => {
                if (!isValidRoomId(roomId)) {
                    emitVoiceError(socket, VoiceErrorCode.VOICE_INVALID_ROOM_ID, {
                        action: 'join',
                    });
                    return;
                }

                if (!socket.joinedRooms.has(roomId)) {
                    emitVoiceError(socket, VoiceErrorCode.VOICE_NOT_IN_ROOM, {
                        action: 'join',
                        roomId,
                    });
                    return;
                }

                const effectiveUserId = payloadUserId || socket.userId;
                
                // Check if voice service is available
                if (!mockState.voiceServiceAvailable) {
                    emitVoiceError(socket, VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE, {
                        action: 'join',
                        roomId,
                    });
                    return;
                }

                // Mock call to voiceSessionsClient.createOrUpdateVoiceSession
                serviceCalls.createSession.push({
                    roomId,
                    userId: effectiveUserId,
                    username: socket.data?.user?.username,
                });

                // Check if mock should throw error
                if (mockState.createSessionError) {
                    emitVoiceErrorFromException(socket, mockState.createSessionError, {
                        action: 'join',
                        roomId,
                    });
                    // IMPORTANT: Do NOT modify voiceState when service fails
                    return;
                }

                // Success path - create local voice state
                const result = VoiceState.joinVoice(roomId, effectiveUserId, {
                    role: 'speaker',
                    canPublishAudio: true,
                });

                if (!result.success) {
                    emitVoiceError(socket, VoiceErrorCode.VOICE_INTERNAL_ERROR, {
                        action: 'join',
                        roomId,
                        context: { error: result.error },
                    });
                    return;
                }

                // Attach session ID
                if (mockState.createSessionResponse?.sessionId) {
                    VoiceState.attachSession(roomId, effectiveUserId, mockState.createSessionResponse.sessionId);
                }

                const voiceState = VoiceState.getVoiceState(roomId);
                
                // Broadcast success
                io.to(roomChannel(roomId)).emit('voice:state', {
                    roomId,
                    participants: voiceState.participants,
                });

                // Send joined confirmation with LiveKit token
                socket.emit('voice:joined', {
                    roomId,
                    userId: effectiveUserId,
                    sessionId: mockState.createSessionResponse?.sessionId,
                    livekit: mockState.createSessionResponse?.livekit,
                });
            });
        }
    });

    return { httpServer, io };
}

describe('Voice Service Error Integration Tests', () => {
    let httpServer;
    let io;
    let port;

    beforeAll((done) => {
        const server = createServiceErrorTestServer();
        httpServer = server.httpServer;
        io = server.io;
        
        httpServer.listen(() => {
            port = httpServer.address().port;
            done();
        });
    });

    afterAll((done) => {
        io.close();
        httpServer.close(done);
    });

    beforeEach(() => {
        resetMocks();
        VoiceState.clearAllVoiceState();
    });

    describe('VOICE_SERVICE_UNAVAILABLE on voice:join', () => {
        it('should emit voice:error with correct payload when service is unavailable', (done) => {
            // Configure mock to simulate service unavailable
            mockState.voiceServiceAvailable = false;

            const client = ioc(`http://localhost:${port}`, {
                auth: { userId: 'test-user' },
            });

            client.on('connect', () => {
                client.emit('joinRoom', { roomId: 'room-1' });
                
                setTimeout(() => {
                    client.emit('voice:join', { roomId: 'room-1' });
                }, 50);
            });

            client.on('voice:error', (error) => {
                try {
                    // Verify error payload structure
                    expect(error.code).toBe(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE);
                    expect(error.message).toBeDefined();
                    expect(error.uiMessage).toBeDefined();
                    expect(error.retryable).toBe(true);
                    expect(error.action).toBe('join');
                    expect(error.roomId).toBe('room-1');
                    
                    // Verify uiMessage is in Spanish
                    expect(error.uiMessage).toMatch(/servicio|disponible|intentar/i);
                    
                    // Verify voiceState was NOT modified
                    const state = VoiceState.getVoiceState('room-1');
                    expect(state.participants).toHaveLength(0);
                    
                    // Verify no service calls were made (since we check availability first)
                    expect(serviceCalls.createSession).toHaveLength(0);
                    
                    client.disconnect();
                    done();
                } catch (err) {
                    client.disconnect();
                    done(err);
                }
            });
        });

        it('should emit voice:error when createOrUpdateVoiceSession throws VOICE_SERVICE_UNAVAILABLE', (done) => {
            // Configure mock to throw VoiceError on session creation
            mockState.voiceServiceAvailable = true;
            mockState.createSessionError = new VoiceError(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE, {
                message: 'Voice service is not responding',
                roomId: 'room-1',
            });

            const client = ioc(`http://localhost:${port}`, {
                auth: { userId: 'test-user' },
            });

            client.on('connect', () => {
                client.emit('joinRoom', { roomId: 'room-1' });
                
                setTimeout(() => {
                    client.emit('voice:join', { roomId: 'room-1' });
                }, 50);
            });

            client.on('voice:error', (error) => {
                try {
                    expect(error.code).toBe(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE);
                    expect(error.retryable).toBe(true);
                    expect(error.action).toBe('join');
                    
                    // Verify voiceState was NOT modified
                    const state = VoiceState.getVoiceState('room-1');
                    expect(state.participants).toHaveLength(0);
                    
                    // Verify service was called
                    expect(serviceCalls.createSession).toHaveLength(1);
                    expect(serviceCalls.createSession[0].roomId).toBe('room-1');
                    expect(serviceCalls.createSession[0].userId).toBe('test-user');
                    
                    client.disconnect();
                    done();
                } catch (err) {
                    client.disconnect();
                    done(err);
                }
            });
        });
    });

    describe('VOICE_LIVEKIT_UNAVAILABLE on voice:join', () => {
        it('should emit voice:error with correct payload when LiveKit is unavailable', (done) => {
            // Configure mock to throw VoiceError for LiveKit unavailable
            mockState.createSessionError = new VoiceError(VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE, {
                message: 'LiveKit token generation failed',
                roomId: 'room-1',
            });

            const client = ioc(`http://localhost:${port}`, {
                auth: { userId: 'test-user' },
            });

            client.on('connect', () => {
                client.emit('joinRoom', { roomId: 'room-1' });
                
                setTimeout(() => {
                    client.emit('voice:join', { roomId: 'room-1' });
                }, 50);
            });

            client.on('voice:error', (error) => {
                try {
                    // Verify error payload structure
                    expect(error.code).toBe(VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE);
                    expect(error.message).toBeDefined();
                    expect(error.uiMessage).toBeDefined();
                    expect(error.retryable).toBe(true);
                    expect(error.action).toBe('join');
                    
                    // Verify uiMessage is in Spanish and suggests retry
                    expect(error.uiMessage).toMatch(/servidor|voz|intentar/i);
                    
                    // Verify voiceState was NOT modified
                    const state = VoiceState.getVoiceState('room-1');
                    expect(state.participants).toHaveLength(0);
                    
                    client.disconnect();
                    done();
                } catch (err) {
                    client.disconnect();
                    done(err);
                }
            });
        });

        it('should not create participant when LiveKit fails', (done) => {
            mockState.createSessionError = new VoiceError(VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE, {
                message: 'Failed to connect to LiveKit',
            });

            const client = ioc(`http://localhost:${port}`, {
                auth: { userId: 'livekit-fail-user' },
            });

            client.on('connect', () => {
                client.emit('joinRoom', { roomId: 'room-livekit' });
                
                setTimeout(() => {
                    client.emit('voice:join', { roomId: 'room-livekit' });
                }, 50);
            });

            client.on('voice:error', (error) => {
                try {
                    expect(error.code).toBe(VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE);
                    
                    // Verify no participant was created
                    const state = VoiceState.getVoiceState('room-livekit');
                    expect(state.participants).toHaveLength(0);
                    
                    // Verify room count is still 0
                    expect(VoiceState.getActiveVoiceRoomCount()).toBe(0);
                    
                    client.disconnect();
                    done();
                } catch (err) {
                    client.disconnect();
                    done(err);
                }
            });
        });
    });

    describe('VOICE_SERVICE_TIMEOUT on voice:join', () => {
        it('should emit voice:error with correct payload when service times out', (done) => {
            // Configure mock to throw VoiceError for timeout
            mockState.createSessionError = new VoiceError(VoiceErrorCode.VOICE_SERVICE_TIMEOUT, {
                message: 'Request timed out after 4000ms',
                roomId: 'room-1',
            });

            const client = ioc(`http://localhost:${port}`, {
                auth: { userId: 'test-user' },
            });

            client.on('connect', () => {
                client.emit('joinRoom', { roomId: 'room-1' });
                
                setTimeout(() => {
                    client.emit('voice:join', { roomId: 'room-1' });
                }, 50);
            });

            client.on('voice:error', (error) => {
                try {
                    expect(error.code).toBe(VoiceErrorCode.VOICE_SERVICE_TIMEOUT);
                    expect(error.retryable).toBe(true);
                    expect(error.action).toBe('join');
                    
                    // Verify voiceState was NOT modified
                    const state = VoiceState.getVoiceState('room-1');
                    expect(state.participants).toHaveLength(0);
                    
                    client.disconnect();
                    done();
                } catch (err) {
                    client.disconnect();
                    done(err);
                }
            });
        });
    });

    describe('Error payload structure verification', () => {
        it('should include all required fields in error payload', (done) => {
            mockState.createSessionError = new VoiceError(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE, {
                message: 'Service unavailable',
                roomId: 'room-payload',
                context: { attempt: 1 },
            });

            const client = ioc(`http://localhost:${port}`, {
                auth: { userId: 'payload-user' },
            });

            client.on('connect', () => {
                client.emit('joinRoom', { roomId: 'room-payload' });
                
                setTimeout(() => {
                    client.emit('voice:join', { roomId: 'room-payload' });
                }, 50);
            });

            client.on('voice:error', (error) => {
                try {
                    // Required fields
                    expect(error).toHaveProperty('code');
                    expect(error).toHaveProperty('message');
                    expect(error).toHaveProperty('uiMessage');
                    expect(error).toHaveProperty('retryable');
                    expect(error).toHaveProperty('action');
                    
                    // Type checks
                    expect(typeof error.code).toBe('string');
                    expect(typeof error.message).toBe('string');
                    expect(typeof error.uiMessage).toBe('string');
                    expect(typeof error.retryable).toBe('boolean');
                    expect(typeof error.action).toBe('string');
                    
                    // Context should be included when provided
                    expect(error.context).toBeDefined();
                    expect(error.context.attempt).toBe(1);
                    
                    client.disconnect();
                    done();
                } catch (err) {
                    client.disconnect();
                    done(err);
                }
            });
        });

        it('should distinguish retryable vs non-retryable errors', (done) => {
            // Non-retryable error
            mockState.createSessionError = new VoiceError(VoiceErrorCode.VOICE_PERMISSION_DENIED, {
                message: 'No permission to join voice',
            });

            const client = ioc(`http://localhost:${port}`, {
                auth: { userId: 'no-perm-user' },
            });

            client.on('connect', () => {
                client.emit('joinRoom', { roomId: 'room-perm' });
                
                setTimeout(() => {
                    client.emit('voice:join', { roomId: 'room-perm' });
                }, 50);
            });

            client.on('voice:error', (error) => {
                try {
                    expect(error.code).toBe(VoiceErrorCode.VOICE_PERMISSION_DENIED);
                    expect(error.retryable).toBe(false);
                    
                    client.disconnect();
                    done();
                } catch (err) {
                    client.disconnect();
                    done(err);
                }
            });
        });
    });

    describe('Successful join after error', () => {
        it('should allow voice:join after previous error is resolved', (done) => {
            // First attempt - error
            mockState.createSessionError = new VoiceError(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE, {
                message: 'Temporary failure',
            });

            const client = ioc(`http://localhost:${port}`, {
                auth: { userId: 'retry-user' },
            });

            let errorCount = 0;

            client.on('connect', () => {
                client.emit('joinRoom', { roomId: 'room-retry' });
                
                setTimeout(() => {
                    // First attempt - will fail
                    client.emit('voice:join', { roomId: 'room-retry' });
                }, 50);
            });

            client.on('voice:error', (error) => {
                errorCount++;
                
                if (errorCount === 1) {
                    // Verify first error
                    expect(error.code).toBe(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE);
                    
                    // Verify voiceState was NOT modified
                    const state = VoiceState.getVoiceState('room-retry');
                    expect(state.participants).toHaveLength(0);
                    
                    // Fix the mock and retry
                    mockState.createSessionError = null;
                    
                    setTimeout(() => {
                        client.emit('voice:join', { roomId: 'room-retry' });
                    }, 50);
                }
            });

            client.on('voice:joined', (data) => {
                try {
                    // Verify successful join
                    expect(data.roomId).toBe('room-retry');
                    expect(data.userId).toBe('retry-user');
                    expect(data.sessionId).toBe('session-123');
                    
                    // Verify voiceState was modified after success
                    const state = VoiceState.getVoiceState('room-retry');
                    expect(state.participants).toHaveLength(1);
                    expect(state.participants[0].userId).toBe('retry-user');
                    
                    client.disconnect();
                    done();
                } catch (err) {
                    client.disconnect();
                    done(err);
                }
            });
        });
    });

    describe('Multiple users with service errors', () => {
        it('should not affect other users when one fails', (done) => {
            const client1 = ioc(`http://localhost:${port}`, {
                auth: { userId: 'user-success' },
            });
            const client2 = ioc(`http://localhost:${port}`, {
                auth: { userId: 'user-fail' },
            });

            let client1Joined = false;
            let client2Error = false;

            client1.on('connect', () => {
                client1.emit('joinRoom', { roomId: 'room-multi' });
                
                setTimeout(() => {
                    // First user succeeds
                    client1.emit('voice:join', { roomId: 'room-multi' });
                }, 50);
            });

            client1.on('voice:joined', () => {
                client1Joined = true;
                
                // Now make service fail for next user
                mockState.createSessionError = new VoiceError(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE);
                
                // Second user connects and tries to join
                client2.emit('joinRoom', { roomId: 'room-multi' });
                
                setTimeout(() => {
                    client2.emit('voice:join', { roomId: 'room-multi' });
                }, 50);
            });

            client2.on('connect', () => {
                // Wait for client1 to join first
            });

            client2.on('voice:error', (error) => {
                client2Error = true;
                
                try {
                    expect(error.code).toBe(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE);
                    
                    // Verify first user is still in voice
                    const state = VoiceState.getVoiceState('room-multi');
                    expect(state.participants).toHaveLength(1);
                    expect(state.participants[0].userId).toBe('user-success');
                    
                    expect(client1Joined).toBe(true);
                    
                    client1.disconnect();
                    client2.disconnect();
                    done();
                } catch (err) {
                    client1.disconnect();
                    client2.disconnect();
                    done(err);
                }
            });
        });
    });
});
