/**
 * Tests for VoiceErrors module
 */

import { jest } from '@jest/globals';
import {
    VoiceErrorCode,
    VoiceErrors,
    VoiceError,
    voiceUnavailableError,
    voiceServiceUnavailableError,
    voiceLiveKitUnavailableError,
    voiceRoomLimitReachedError,
    voicePermissionDeniedError,
    voiceTargetNotInVoiceError,
    voiceNotInRoomError,
    voiceServiceTimeoutError,
    voiceInternalError,
    mapHttpStatusToVoiceErrorCode,
    mapServiceErrorToVoiceErrorCode,
    wrapAsVoiceError,
    isRetryableVoiceError,
} from './voiceErrors.js';

describe('VoiceErrors', () => {
    describe('VoiceErrorCode enum', () => {
        it('should have all expected error codes', () => {
            expect(VoiceErrorCode.VOICE_UNAVAILABLE).toBe('VOICE_UNAVAILABLE');
            expect(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE).toBe('VOICE_SERVICE_UNAVAILABLE');
            expect(VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE).toBe('VOICE_LIVEKIT_UNAVAILABLE');
            expect(VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED).toBe('VOICE_ROOM_LIMIT_REACHED');
            expect(VoiceErrorCode.VOICE_PERMISSION_DENIED).toBe('VOICE_PERMISSION_DENIED');
            expect(VoiceErrorCode.VOICE_TARGET_NOT_IN_VOICE).toBe('VOICE_TARGET_NOT_IN_VOICE');
            expect(VoiceErrorCode.VOICE_NOT_IN_ROOM).toBe('VOICE_NOT_IN_ROOM');
            expect(VoiceErrorCode.VOICE_INVALID_ROOM_ID).toBe('VOICE_INVALID_ROOM_ID');
            expect(VoiceErrorCode.VOICE_INVALID_USER_ID).toBe('VOICE_INVALID_USER_ID');
            expect(VoiceErrorCode.VOICE_SERVICE_TIMEOUT).toBe('VOICE_SERVICE_TIMEOUT');
            expect(VoiceErrorCode.VOICE_INTERNAL_ERROR).toBe('VOICE_INTERNAL_ERROR');
        });
    });

    describe('VoiceErrors catalog', () => {
        it('should have definitions for all error codes', () => {
            Object.values(VoiceErrorCode).forEach((code) => {
                const def = VoiceErrors[code];
                expect(def).toBeDefined();
                expect(def.code).toBe(code);
                expect(typeof def.message).toBe('string');
                expect(typeof def.uiMessage).toBe('string');
                expect(typeof def.retryable).toBe('boolean');
            });
        });

        it('should have Spanish UI messages', () => {
            // All UI messages should be in Spanish
            expect(VoiceErrors[VoiceErrorCode.VOICE_UNAVAILABLE].uiMessage).toContain('voz');
            expect(VoiceErrors[VoiceErrorCode.VOICE_PERMISSION_DENIED].uiMessage).toContain('permisos');
            expect(VoiceErrors[VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED].uiMessage).toContain('límite');
        });

        it('should mark retryable errors correctly', () => {
            // Service/timeout errors should be retryable
            expect(VoiceErrors[VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE].retryable).toBe(true);
            expect(VoiceErrors[VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE].retryable).toBe(true);
            expect(VoiceErrors[VoiceErrorCode.VOICE_SERVICE_TIMEOUT].retryable).toBe(true);
            expect(VoiceErrors[VoiceErrorCode.VOICE_INTERNAL_ERROR].retryable).toBe(true);

            // Client errors should NOT be retryable
            expect(VoiceErrors[VoiceErrorCode.VOICE_UNAVAILABLE].retryable).toBe(false);
            expect(VoiceErrors[VoiceErrorCode.VOICE_PERMISSION_DENIED].retryable).toBe(false);
            expect(VoiceErrors[VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED].retryable).toBe(false);
            expect(VoiceErrors[VoiceErrorCode.VOICE_NOT_IN_ROOM].retryable).toBe(false);
        });
    });

    describe('VoiceError class', () => {
        it('should create error with code and default properties', () => {
            const err = new VoiceError(VoiceErrorCode.VOICE_PERMISSION_DENIED);

            expect(err).toBeInstanceOf(Error);
            expect(err).toBeInstanceOf(VoiceError);
            expect(err.name).toBe('VoiceError');
            expect(err.code).toBe(VoiceErrorCode.VOICE_PERMISSION_DENIED);
            expect(err.message).toBe(VoiceErrors[VoiceErrorCode.VOICE_PERMISSION_DENIED].message);
            expect(err.uiMessage).toBe(VoiceErrors[VoiceErrorCode.VOICE_PERMISSION_DENIED].uiMessage);
            expect(err.retryable).toBe(false);
        });

        it('should allow overriding message and uiMessage', () => {
            const err = new VoiceError(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE, {
                message: 'Custom backend message',
                uiMessage: 'Mensaje personalizado',
            });

            expect(err.message).toBe('Custom backend message');
            expect(err.uiMessage).toBe('Mensaje personalizado');
        });

        it('should allow overriding retryable', () => {
            const err = new VoiceError(VoiceErrorCode.VOICE_PERMISSION_DENIED, {
                retryable: true,
            });

            expect(err.retryable).toBe(true);
        });

        it('should store roomId and userId', () => {
            const err = new VoiceError(VoiceErrorCode.VOICE_NOT_IN_ROOM, {
                roomId: 'room-123',
                userId: 'user-456',
            });

            expect(err.roomId).toBe('room-123');
            expect(err.userId).toBe('user-456');
        });

        it('should store context and cause', () => {
            const originalError = new Error('Original error');
            const err = new VoiceError(VoiceErrorCode.VOICE_INTERNAL_ERROR, {
                context: { action: 'join', attempt: 2 },
                cause: originalError,
            });

            expect(err.context).toEqual({ action: 'join', attempt: 2 });
            expect(err.cause).toBe(originalError);
        });

        it('should fallback to VOICE_INTERNAL_ERROR for unknown codes', () => {
            const err = new VoiceError('UNKNOWN_CODE');

            expect(err.code).toBe('UNKNOWN_CODE');
            expect(err.message).toBe(VoiceErrors[VoiceErrorCode.VOICE_INTERNAL_ERROR].message);
            expect(err.uiMessage).toBe(VoiceErrors[VoiceErrorCode.VOICE_INTERNAL_ERROR].uiMessage);
        });

        describe('toSocketPayload', () => {
            it('should return payload with all fields', () => {
                const err = new VoiceError(VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED, {
                    roomId: 'room-abc',
                    context: { maxSpeakers: 5 },
                });

                const payload = err.toSocketPayload();

                expect(payload).toEqual({
                    code: VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED,
                    message: expect.any(String),
                    uiMessage: expect.any(String),
                    retryable: false,
                    roomId: 'room-abc',
                    context: { maxSpeakers: 5 },
                });
            });

            it('should omit undefined context', () => {
                const err = new VoiceError(VoiceErrorCode.VOICE_PERMISSION_DENIED);

                const payload = err.toSocketPayload();

                expect(payload.context).toBeUndefined();
                expect('context' in payload).toBe(false);
            });
        });

        describe('toLogObject', () => {
            it('should return loggable object with all fields', () => {
                const cause = new Error('Network error');
                const err = new VoiceError(VoiceErrorCode.VOICE_SERVICE_TIMEOUT, {
                    roomId: 'room-123',
                    userId: 'user-456',
                    context: { attempt: 3 },
                    cause,
                });

                const logObj = err.toLogObject();

                expect(logObj).toMatchObject({
                    name: 'VoiceError',
                    code: VoiceErrorCode.VOICE_SERVICE_TIMEOUT,
                    retryable: true,
                    roomId: 'room-123',
                    userId: 'user-456',
                    context: { attempt: 3 },
                    cause: 'Network error',
                });
                expect(logObj.stack).toBeDefined();
            });
        });
    });

    describe('Factory functions', () => {
        it('voiceUnavailableError should create correct error', () => {
            const err = voiceUnavailableError({ roomId: 'room-1' });
            
            expect(err.code).toBe(VoiceErrorCode.VOICE_UNAVAILABLE);
            expect(err.roomId).toBe('room-1');
            expect(err.retryable).toBe(false);
        });

        it('voiceServiceUnavailableError should create correct error', () => {
            const err = voiceServiceUnavailableError();
            
            expect(err.code).toBe(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE);
            expect(err.retryable).toBe(true);
        });

        it('voiceLiveKitUnavailableError should create correct error', () => {
            const err = voiceLiveKitUnavailableError();
            
            expect(err.code).toBe(VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE);
            expect(err.retryable).toBe(true);
        });

        it('voiceRoomLimitReachedError should create correct error', () => {
            const err = voiceRoomLimitReachedError({ context: { maxSpeakers: 10 } });
            
            expect(err.code).toBe(VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED);
            expect(err.retryable).toBe(false);
            expect(err.context).toEqual({ maxSpeakers: 10 });
        });

        it('voicePermissionDeniedError should create correct error', () => {
            const err = voicePermissionDeniedError();
            
            expect(err.code).toBe(VoiceErrorCode.VOICE_PERMISSION_DENIED);
            expect(err.retryable).toBe(false);
        });

        it('voiceTargetNotInVoiceError should create correct error', () => {
            const err = voiceTargetNotInVoiceError({ userId: 'target-user' });
            
            expect(err.code).toBe(VoiceErrorCode.VOICE_TARGET_NOT_IN_VOICE);
            expect(err.userId).toBe('target-user');
        });

        it('voiceNotInRoomError should create correct error', () => {
            const err = voiceNotInRoomError({ roomId: 'room-xyz' });
            
            expect(err.code).toBe(VoiceErrorCode.VOICE_NOT_IN_ROOM);
            expect(err.roomId).toBe('room-xyz');
        });

        it('voiceServiceTimeoutError should create correct error', () => {
            const err = voiceServiceTimeoutError();
            
            expect(err.code).toBe(VoiceErrorCode.VOICE_SERVICE_TIMEOUT);
            expect(err.retryable).toBe(true);
        });

        it('voiceInternalError should create correct error', () => {
            const cause = new Error('Something went wrong');
            const err = voiceInternalError({ cause });
            
            expect(err.code).toBe(VoiceErrorCode.VOICE_INTERNAL_ERROR);
            expect(err.cause).toBe(cause);
            expect(err.retryable).toBe(true);
        });
    });

    describe('mapHttpStatusToVoiceErrorCode', () => {
        it('should map 503 to VOICE_LIVEKIT_UNAVAILABLE', () => {
            expect(mapHttpStatusToVoiceErrorCode(503)).toBe(VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE);
        });

        it('should map 5xx to VOICE_SERVICE_UNAVAILABLE', () => {
            expect(mapHttpStatusToVoiceErrorCode(500)).toBe(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE);
            expect(mapHttpStatusToVoiceErrorCode(502)).toBe(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE);
            expect(mapHttpStatusToVoiceErrorCode(504)).toBe(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE);
        });

        it('should map 403 to VOICE_PERMISSION_DENIED', () => {
            expect(mapHttpStatusToVoiceErrorCode(403)).toBe(VoiceErrorCode.VOICE_PERMISSION_DENIED);
        });

        it('should map 404 to VOICE_TARGET_NOT_IN_VOICE', () => {
            expect(mapHttpStatusToVoiceErrorCode(404)).toBe(VoiceErrorCode.VOICE_TARGET_NOT_IN_VOICE);
        });

        it('should map 429 to VOICE_ROOM_LIMIT_REACHED', () => {
            expect(mapHttpStatusToVoiceErrorCode(429)).toBe(VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED);
        });

        it('should map other status codes to VOICE_INTERNAL_ERROR', () => {
            expect(mapHttpStatusToVoiceErrorCode(400)).toBe(VoiceErrorCode.VOICE_INTERNAL_ERROR);
            expect(mapHttpStatusToVoiceErrorCode(401)).toBe(VoiceErrorCode.VOICE_INTERNAL_ERROR);
            expect(mapHttpStatusToVoiceErrorCode(422)).toBe(VoiceErrorCode.VOICE_INTERNAL_ERROR);
        });
    });

    describe('mapServiceErrorToVoiceErrorCode', () => {
        it('should map LiveKit errors correctly', () => {
            expect(mapServiceErrorToVoiceErrorCode('DEPENDENCY_UNAVAILABLE')).toBe(VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE);
            expect(mapServiceErrorToVoiceErrorCode('LIVEKIT_ERROR')).toBe(VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE);
            expect(mapServiceErrorToVoiceErrorCode('TOKEN_GENERATION_FAILED')).toBe(VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE);
        });

        it('should map service errors correctly', () => {
            expect(mapServiceErrorToVoiceErrorCode('SERVICE_UNAVAILABLE')).toBe(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE);
            expect(mapServiceErrorToVoiceErrorCode('SESSION_NOT_FOUND')).toBe(VoiceErrorCode.VOICE_TARGET_NOT_IN_VOICE);
            expect(mapServiceErrorToVoiceErrorCode('ROOM_NOT_FOUND')).toBe(VoiceErrorCode.VOICE_INVALID_ROOM_ID);
            expect(mapServiceErrorToVoiceErrorCode('USER_NOT_FOUND')).toBe(VoiceErrorCode.VOICE_INVALID_USER_ID);
            expect(mapServiceErrorToVoiceErrorCode('PERMISSION_DENIED')).toBe(VoiceErrorCode.VOICE_PERMISSION_DENIED);
            expect(mapServiceErrorToVoiceErrorCode('MAX_SPEAKERS_REACHED')).toBe(VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED);
        });

        it('should map unknown codes to VOICE_INTERNAL_ERROR', () => {
            expect(mapServiceErrorToVoiceErrorCode('UNKNOWN_CODE')).toBe(VoiceErrorCode.VOICE_INTERNAL_ERROR);
            expect(mapServiceErrorToVoiceErrorCode('')).toBe(VoiceErrorCode.VOICE_INTERNAL_ERROR);
        });
    });

    describe('wrapAsVoiceError', () => {
        it('should return VoiceError as-is', () => {
            const original = new VoiceError(VoiceErrorCode.VOICE_PERMISSION_DENIED);
            const wrapped = wrapAsVoiceError(original);

            expect(wrapped).toBe(original);
        });

        it('should wrap AbortError as VOICE_SERVICE_TIMEOUT', () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';

            const wrapped = wrapAsVoiceError(err);

            expect(wrapped.code).toBe(VoiceErrorCode.VOICE_SERVICE_TIMEOUT);
            expect(wrapped.cause).toBe(err);
        });

        it('should wrap ECONNREFUSED as VOICE_SERVICE_UNAVAILABLE', () => {
            const err = new Error('Connection refused');
            err.code = 'ECONNREFUSED';

            const wrapped = wrapAsVoiceError(err);

            expect(wrapped.code).toBe(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE);
            expect(wrapped.cause).toBe(err);
        });

        it('should wrap ETIMEDOUT as VOICE_SERVICE_UNAVAILABLE', () => {
            const err = new Error('Connection timed out');
            err.code = 'ETIMEDOUT';

            const wrapped = wrapAsVoiceError(err);

            expect(wrapped.code).toBe(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE);
            expect(wrapped.cause).toBe(err);
        });

        it('should wrap ENOTFOUND as VOICE_SERVICE_UNAVAILABLE', () => {
            const err = new Error('DNS not found');
            err.code = 'ENOTFOUND';

            const wrapped = wrapAsVoiceError(err);

            expect(wrapped.code).toBe(VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE);
            expect(wrapped.cause).toBe(err);
        });

        it('should wrap generic errors as VOICE_INTERNAL_ERROR', () => {
            const err = new Error('Something failed');

            const wrapped = wrapAsVoiceError(err, { roomId: 'room-1' });

            expect(wrapped.code).toBe(VoiceErrorCode.VOICE_INTERNAL_ERROR);
            expect(wrapped.message).toBe('Something failed');
            expect(wrapped.cause).toBe(err);
            expect(wrapped.roomId).toBe('room-1');
        });
    });

    describe('isRetryableVoiceError', () => {
        it('should return true for retryable VoiceErrors', () => {
            const err = new VoiceError(VoiceErrorCode.VOICE_SERVICE_TIMEOUT);
            expect(isRetryableVoiceError(err)).toBe(true);
        });

        it('should return false for non-retryable VoiceErrors', () => {
            const err = new VoiceError(VoiceErrorCode.VOICE_PERMISSION_DENIED);
            expect(isRetryableVoiceError(err)).toBe(false);
        });

        it('should return true for AbortError', () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            expect(isRetryableVoiceError(err)).toBe(true);
        });

        it('should return true for network errors', () => {
            const econnrefused = new Error('Connection refused');
            econnrefused.code = 'ECONNREFUSED';
            expect(isRetryableVoiceError(econnrefused)).toBe(true);

            const etimedout = new Error('Timed out');
            etimedout.code = 'ETIMEDOUT';
            expect(isRetryableVoiceError(etimedout)).toBe(true);
        });

        it('should return false for generic errors', () => {
            const err = new Error('Generic error');
            expect(isRetryableVoiceError(err)).toBe(false);
        });
    });
});
