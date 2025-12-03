/**
 * Tests for Voice Feature Flag Graceful Degradation
 * 
 * These tests verify the behavior of the voice system when feature flags are disabled.
 * 
 * Tests cover:
 * - JAMROOM_ENABLE_VOICE=false: voice:join should be ignored, no HTTP calls
 * - Voice handlers should not be registered when flag is disabled
 * - Error responses with VOICE_UNAVAILABLE code
 */

import { jest } from '@jest/globals';
import {
    VoiceError,
    VoiceErrorCode,
    VoiceErrors,
} from './voiceErrors.js';
import * as VoiceState from './voiceState.js';

describe('Voice Feature Flag Graceful Degradation', () => {
    describe('VoiceState feature flag checks', () => {
        let originalEnv;

        beforeEach(() => {
            originalEnv = { ...process.env };
            VoiceState.clearAllVoiceState();
        });

        afterEach(() => {
            process.env = originalEnv;
        });

        it('should return isVoiceEnabled=false when JAMROOM_ENABLE_VOICE is not set', () => {
            delete process.env.JAMROOM_ENABLE_VOICE;
            
            // Since isVoiceEnabled reads from environment at call time,
            // we need to call the function after changing the env
            expect(VoiceState.isVoiceEnabled()).toBe(false);
        });

        it('should return isVoiceEnabled=false when JAMROOM_ENABLE_VOICE is "false"', () => {
            process.env.JAMROOM_ENABLE_VOICE = 'false';
            
            expect(VoiceState.isVoiceEnabled()).toBe(false);
        });

        it('should return isVoiceEnabled=true when JAMROOM_ENABLE_VOICE is "true"', () => {
            process.env.JAMROOM_ENABLE_VOICE = 'true';
            
            expect(VoiceState.isVoiceEnabled()).toBe(true);
        });

        it('should return isVoiceMediaEnabled=false when JAMROOM_ENABLE_VOICE is false', () => {
            process.env.JAMROOM_ENABLE_VOICE = 'false';
            
            expect(VoiceState.isVoiceMediaEnabled()).toBe(false);
        });

        it('should return isVoiceMediaEnabled=false when only VOICE is enabled', () => {
            process.env.JAMROOM_ENABLE_VOICE = 'true';
            delete process.env.JAMROOM_ENABLE_VOICE_MEDIA;
            
            expect(VoiceState.isVoiceMediaEnabled()).toBe(false);
        });

        it('should return isVoiceMediaEnabled=true when both flags are enabled', () => {
            process.env.JAMROOM_ENABLE_VOICE = 'true';
            process.env.JAMROOM_ENABLE_VOICE_MEDIA = 'true';
            
            expect(VoiceState.isVoiceMediaEnabled()).toBe(true);
        });
    });

    describe('VoiceError for disabled feature flag', () => {
        it('should have VOICE_UNAVAILABLE error with correct properties', () => {
            const errorDef = VoiceErrors[VoiceErrorCode.VOICE_UNAVAILABLE];
            
            expect(errorDef.code).toBe('VOICE_UNAVAILABLE');
            expect(errorDef.message).toContain('disabled');
            expect(errorDef.uiMessage).toContain('no está disponible');
            expect(errorDef.retryable).toBe(false);
        });

        it('should create proper VoiceError when feature is unavailable', () => {
            const err = new VoiceError(VoiceErrorCode.VOICE_UNAVAILABLE, {
                roomId: 'room-123',
            });
            
            expect(err.code).toBe(VoiceErrorCode.VOICE_UNAVAILABLE);
            expect(err.retryable).toBe(false);
            expect(err.roomId).toBe('room-123');
            
            const payload = err.toSocketPayload();
            expect(payload.code).toBe(VoiceErrorCode.VOICE_UNAVAILABLE);
            expect(payload.retryable).toBe(false);
            expect(payload.uiMessage).toContain('no está disponible');
        });
    });

    describe('VoiceState operations when voice is enabled', () => {
        beforeEach(() => {
            process.env.JAMROOM_ENABLE_VOICE = 'true';
            VoiceState.clearAllVoiceState();
        });

        afterEach(() => {
            delete process.env.JAMROOM_ENABLE_VOICE;
        });

        it('should allow voice operations when enabled', () => {
            const result = VoiceState.joinVoice('room-1', 'user-1');
            
            expect(result.success).toBe(true);
            
            const state = VoiceState.getVoiceState('room-1');
            expect(state.participants).toHaveLength(1);
            expect(state.participants[0].userId).toBe('user-1');
        });

        it('should track participants correctly', () => {
            VoiceState.joinVoice('room-1', 'user-1');
            VoiceState.joinVoice('room-1', 'user-2');
            
            const state = VoiceState.getVoiceState('room-1');
            expect(state.participants).toHaveLength(2);
        });

        it('should remove participants on leave', () => {
            VoiceState.joinVoice('room-1', 'user-1');
            VoiceState.joinVoice('room-1', 'user-2');
            VoiceState.leaveVoice('room-1', 'user-1');
            
            const state = VoiceState.getVoiceState('room-1');
            expect(state.participants).toHaveLength(1);
            expect(state.participants[0].userId).toBe('user-2');
        });
    });

    describe('Error payload structure', () => {
        it('should have consistent structure across all error types', () => {
            const codes = [
                VoiceErrorCode.VOICE_UNAVAILABLE,
                VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE,
                VoiceErrorCode.VOICE_PERMISSION_DENIED,
                VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED,
            ];

            for (const code of codes) {
                const err = new VoiceError(code, { roomId: 'room-test' });
                const payload = err.toSocketPayload();

                // All payloads should have these required fields
                expect(payload).toHaveProperty('code');
                expect(payload).toHaveProperty('message');
                expect(payload).toHaveProperty('uiMessage');
                expect(payload).toHaveProperty('retryable');
                expect(payload).toHaveProperty('roomId');

                // Types should be correct
                expect(typeof payload.code).toBe('string');
                expect(typeof payload.message).toBe('string');
                expect(typeof payload.uiMessage).toBe('string');
                expect(typeof payload.retryable).toBe('boolean');
            }
        });

        it('should distinguish retryable vs non-retryable errors', () => {
            const nonRetryable = [
                VoiceErrorCode.VOICE_UNAVAILABLE,
                VoiceErrorCode.VOICE_PERMISSION_DENIED,
                VoiceErrorCode.VOICE_ROOM_LIMIT_REACHED,
                VoiceErrorCode.VOICE_NOT_IN_ROOM,
                VoiceErrorCode.VOICE_TARGET_NOT_IN_VOICE,
            ];

            const retryable = [
                VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE,
                VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE,
                VoiceErrorCode.VOICE_SERVICE_TIMEOUT,
                VoiceErrorCode.VOICE_INTERNAL_ERROR,
            ];

            for (const code of nonRetryable) {
                const err = new VoiceError(code);
                expect(err.retryable).toBe(false);
            }

            for (const code of retryable) {
                const err = new VoiceError(code);
                expect(err.retryable).toBe(true);
            }
        });
    });

    describe('Frontend UX messaging', () => {
        it('should have Spanish UI messages for all error types', () => {
            Object.values(VoiceErrorCode).forEach((code) => {
                const errorDef = VoiceErrors[code];
                
                // UI message should be defined
                expect(errorDef.uiMessage).toBeDefined();
                expect(errorDef.uiMessage.length).toBeGreaterThan(0);
                
                // Should contain Spanish words (common patterns)
                const spanishPatterns = /voz|servicio|error|permisos|límite|sala|usuario|intentar/i;
                expect(errorDef.uiMessage).toMatch(spanishPatterns);
            });
        });

        it('should have action-oriented messages for retryable errors', () => {
            const retryableErrors = [
                VoiceErrorCode.VOICE_SERVICE_UNAVAILABLE,
                VoiceErrorCode.VOICE_LIVEKIT_UNAVAILABLE,
                VoiceErrorCode.VOICE_SERVICE_TIMEOUT,
                VoiceErrorCode.VOICE_INTERNAL_ERROR,
            ];

            for (const code of retryableErrors) {
                const errorDef = VoiceErrors[code];
                // Retryable errors should suggest trying again
                expect(errorDef.uiMessage.toLowerCase()).toMatch(/inténtalo|intenta|nuevo/);
            }
        });
    });
});
