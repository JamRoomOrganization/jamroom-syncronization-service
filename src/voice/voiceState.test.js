/**
 * Unit tests for VoiceState module
 */

import {
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
    setServerMuted,
    setRole,
    getParticipant,
    setCanPublishAudio,
    countSpeakers,
} from './voiceState.js';

describe('VoiceState', () => {
    // Clean up before each test
    beforeEach(() => {
        clearAllVoiceState();
    });

    describe('joinVoice', () => {
        it('should successfully add a user to a voice channel', () => {
            const result = joinVoice('room-1', 'user-1');
            
            expect(result.success).toBe(true);
            expect(result.error).toBeUndefined();
        });

        it('should return success when user joins again (idempotent)', () => {
            joinVoice('room-1', 'user-1');
            const result = joinVoice('room-1', 'user-1');
            
            expect(result.success).toBe(true);
        });

        it('should return error for invalid roomId', () => {
            const result1 = joinVoice('', 'user-1');
            const result2 = joinVoice(null, 'user-1');
            const result3 = joinVoice(undefined, 'user-1');
            const result4 = joinVoice(123, 'user-1');
            
            expect(result1.success).toBe(false);
            expect(result1.error).toBe('invalid_room_id');
            expect(result2.success).toBe(false);
            expect(result3.success).toBe(false);
            expect(result4.success).toBe(false);
        });

        it('should return error for invalid userId', () => {
            const result1 = joinVoice('room-1', '');
            const result2 = joinVoice('room-1', null);
            const result3 = joinVoice('room-1', undefined);
            const result4 = joinVoice('room-1', 123);
            
            expect(result1.success).toBe(false);
            expect(result1.error).toBe('invalid_user_id');
            expect(result2.success).toBe(false);
            expect(result3.success).toBe(false);
            expect(result4.success).toBe(false);
        });

        it('should set user as unmuted by default', () => {
            joinVoice('room-1', 'user-1');
            const state = getVoiceState('room-1');
            
            expect(state.participants).toHaveLength(1);
            expect(state.participants[0].userId).toBe('user-1');
            expect(state.participants[0].muted).toBe(false);
        });

        it('should allow multiple users in the same room', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-1', 'user-2');
            joinVoice('room-1', 'user-3');
            
            const state = getVoiceState('room-1');
            expect(state.participants).toHaveLength(3);
        });
    });

    describe('leaveVoice', () => {
        it('should successfully remove a user from a voice channel', () => {
            joinVoice('room-1', 'user-1');
            const result = leaveVoice('room-1', 'user-1');
            
            expect(result.success).toBe(true);
            
            const state = getVoiceState('room-1');
            expect(state.participants).toHaveLength(0);
        });

        it('should return success when leaving a room user is not in (idempotent)', () => {
            const result = leaveVoice('room-1', 'user-1');
            expect(result.success).toBe(true);
        });

        it('should return success when leaving a non-existent room (idempotent)', () => {
            const result = leaveVoice('non-existent-room', 'user-1');
            expect(result.success).toBe(true);
        });

        it('should return error for invalid roomId', () => {
            const result = leaveVoice('', 'user-1');
            expect(result.success).toBe(false);
            expect(result.error).toBe('invalid_room_id');
        });

        it('should return error for invalid userId', () => {
            const result = leaveVoice('room-1', '');
            expect(result.success).toBe(false);
            expect(result.error).toBe('invalid_user_id');
        });

        it('should clean up empty rooms', () => {
            joinVoice('room-1', 'user-1');
            leaveVoice('room-1', 'user-1');
            
            expect(getActiveVoiceRoomCount()).toBe(0);
        });

        it('should not remove other users when one leaves', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-1', 'user-2');
            leaveVoice('room-1', 'user-1');
            
            const state = getVoiceState('room-1');
            expect(state.participants).toHaveLength(1);
            expect(state.participants[0].userId).toBe('user-2');
        });
    });

    describe('setMute', () => {
        it('should successfully mute a user', () => {
            joinVoice('room-1', 'user-1');
            const result = setMute('room-1', 'user-1', true);
            
            expect(result.success).toBe(true);
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].muted).toBe(true);
        });

        it('should successfully unmute a user', () => {
            joinVoice('room-1', 'user-1');
            setMute('room-1', 'user-1', true);
            const result = setMute('room-1', 'user-1', false);
            
            expect(result.success).toBe(true);
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].muted).toBe(false);
        });

        it('should return error when user is not in voice', () => {
            const result = setMute('room-1', 'user-1', true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('user_not_in_voice');
        });

        it('should return error when room does not exist', () => {
            const result = setMute('non-existent', 'user-1', true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('user_not_in_voice');
        });

        it('should return error for invalid roomId', () => {
            const result = setMute('', 'user-1', true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('invalid_room_id');
        });

        it('should return error for invalid userId', () => {
            joinVoice('room-1', 'user-1');
            const result = setMute('room-1', '', true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('invalid_user_id');
        });

        it('should return error for invalid muted value', () => {
            joinVoice('room-1', 'user-1');
            
            const result1 = setMute('room-1', 'user-1', 'true');
            const result2 = setMute('room-1', 'user-1', 1);
            const result3 = setMute('room-1', 'user-1', null);
            const result4 = setMute('room-1', 'user-1', undefined);
            
            expect(result1.success).toBe(false);
            expect(result1.error).toBe('invalid_muted_value');
            expect(result2.success).toBe(false);
            expect(result3.success).toBe(false);
            expect(result4.success).toBe(false);
        });

        it('should only affect the specified user', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-1', 'user-2');
            setMute('room-1', 'user-1', true);
            
            const state = getVoiceState('room-1');
            const user1 = state.participants.find(p => p.userId === 'user-1');
            const user2 = state.participants.find(p => p.userId === 'user-2');
            
            expect(user1.muted).toBe(true);
            expect(user2.muted).toBe(false);
        });
    });

    describe('getVoiceState', () => {
        it('should return empty participants for a new room', () => {
            const state = getVoiceState('room-1');
            
            expect(state.roomId).toBe('room-1');
            expect(state.participants).toEqual([]);
        });

        it('should return empty participants for invalid roomId', () => {
            const state1 = getVoiceState('');
            const state2 = getVoiceState(null);
            const state3 = getVoiceState(undefined);
            
            expect(state1.participants).toEqual([]);
            expect(state2.participants).toEqual([]);
            expect(state3.participants).toEqual([]);
        });

        it('should return correct participant list', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-1', 'user-2');
            setMute('room-1', 'user-1', true);
            
            const state = getVoiceState('room-1');
            
            expect(state.roomId).toBe('room-1');
            expect(state.participants).toHaveLength(2);
            
            const user1 = state.participants.find(p => p.userId === 'user-1');
            const user2 = state.participants.find(p => p.userId === 'user-2');
            
            expect(user1).toEqual({ userId: 'user-1', muted: true, serverMuted: false, canPublishAudio: true });
            expect(user2).toEqual({ userId: 'user-2', muted: false, serverMuted: false, canPublishAudio: true });
        });

        it('should return only public fields (userId, muted, serverMuted, canPublishAudio, and optionally role)', () => {
            joinVoice('room-1', 'user-1');
            
            const state = getVoiceState('room-1');
            const participant = state.participants[0];
            
            // Should have at least userId, muted, serverMuted, canPublishAudio
            expect(participant).toHaveProperty('userId');
            expect(participant).toHaveProperty('muted');
            expect(participant).toHaveProperty('serverMuted');
            expect(participant).toHaveProperty('canPublishAudio');
            // Should NOT have sessionId (internal)
            expect(participant).not.toHaveProperty('sessionId');
        });
    });

    describe('clearAllVoiceState', () => {
        it('should clear all rooms', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-2', 'user-2');
            joinVoice('room-3', 'user-3');
            
            expect(getActiveVoiceRoomCount()).toBe(3);
            
            clearAllVoiceState();
            
            expect(getActiveVoiceRoomCount()).toBe(0);
            expect(getVoiceState('room-1').participants).toEqual([]);
            expect(getVoiceState('room-2').participants).toEqual([]);
            expect(getVoiceState('room-3').participants).toEqual([]);
        });
    });

    describe('getActiveVoiceRoomCount', () => {
        it('should return 0 for no active rooms', () => {
            expect(getActiveVoiceRoomCount()).toBe(0);
        });

        it('should return correct count of active rooms', () => {
            joinVoice('room-1', 'user-1');
            expect(getActiveVoiceRoomCount()).toBe(1);
            
            joinVoice('room-2', 'user-2');
            expect(getActiveVoiceRoomCount()).toBe(2);
            
            joinVoice('room-1', 'user-2'); // Same room, different user
            expect(getActiveVoiceRoomCount()).toBe(2);
        });

        it('should decrease when rooms become empty', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-2', 'user-2');
            
            expect(getActiveVoiceRoomCount()).toBe(2);
            
            leaveVoice('room-1', 'user-1');
            expect(getActiveVoiceRoomCount()).toBe(1);
        });
    });

    describe('getRoomsForUser', () => {
        it('should return empty array for user not in any room', () => {
            expect(getRoomsForUser('user-1')).toEqual([]);
        });

        it('should return empty array for invalid userId', () => {
            expect(getRoomsForUser('')).toEqual([]);
            expect(getRoomsForUser(null)).toEqual([]);
            expect(getRoomsForUser(undefined)).toEqual([]);
        });

        it('should return single room when user is in one room', () => {
            joinVoice('room-1', 'user-1');
            
            const rooms = getRoomsForUser('user-1');
            expect(rooms).toHaveLength(1);
            expect(rooms).toContain('room-1');
        });

        it('should return multiple rooms when user is in multiple rooms', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-2', 'user-1');
            joinVoice('room-3', 'user-1');
            
            const rooms = getRoomsForUser('user-1');
            expect(rooms).toHaveLength(3);
            expect(rooms).toContain('room-1');
            expect(rooms).toContain('room-2');
            expect(rooms).toContain('room-3');
        });

        it('should not include rooms where user has left', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-2', 'user-1');
            leaveVoice('room-1', 'user-1');
            
            const rooms = getRoomsForUser('user-1');
            expect(rooms).toHaveLength(1);
            expect(rooms).toContain('room-2');
            expect(rooms).not.toContain('room-1');
        });

        it('should only return rooms for the specific user', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-2', 'user-2');
            joinVoice('room-3', 'user-1');
            
            const rooms1 = getRoomsForUser('user-1');
            const rooms2 = getRoomsForUser('user-2');
            
            expect(rooms1).toHaveLength(2);
            expect(rooms1).toContain('room-1');
            expect(rooms1).toContain('room-3');
            
            expect(rooms2).toHaveLength(1);
            expect(rooms2).toContain('room-2');
        });
    });

    describe('Integration scenarios', () => {
        it('should handle a typical voice session flow', () => {
            // Users join room
            joinVoice('room-1', 'user-1');
            joinVoice('room-1', 'user-2');
            joinVoice('room-1', 'user-3');
            
            let state = getVoiceState('room-1');
            expect(state.participants).toHaveLength(3);
            
            // User mutes themselves
            setMute('room-1', 'user-2', true);
            state = getVoiceState('room-1');
            expect(state.participants.find(p => p.userId === 'user-2').muted).toBe(true);
            
            // User unmutes
            setMute('room-1', 'user-2', false);
            state = getVoiceState('room-1');
            expect(state.participants.find(p => p.userId === 'user-2').muted).toBe(false);
            
            // User leaves
            leaveVoice('room-1', 'user-3');
            state = getVoiceState('room-1');
            expect(state.participants).toHaveLength(2);
            expect(state.participants.find(p => p.userId === 'user-3')).toBeUndefined();
            
            // All users leave
            leaveVoice('room-1', 'user-1');
            leaveVoice('room-1', 'user-2');
            
            expect(getActiveVoiceRoomCount()).toBe(0);
        });

        it('should isolate rooms from each other', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-2', 'user-1');
            joinVoice('room-2', 'user-2');
            
            setMute('room-1', 'user-1', true);
            
            const state1 = getVoiceState('room-1');
            const state2 = getVoiceState('room-2');
            
            // User should be muted in room-1 but not in room-2
            expect(state1.participants.find(p => p.userId === 'user-1').muted).toBe(true);
            expect(state2.participants.find(p => p.userId === 'user-1').muted).toBe(false);
            
            // Leaving room-1 should not affect room-2
            leaveVoice('room-1', 'user-1');
            
            expect(getVoiceState('room-1').participants).toHaveLength(0);
            expect(getVoiceState('room-2').participants).toHaveLength(2);
        });
    });

    describe('isVoiceEnabled', () => {
        const originalEnv = process.env.JAMROOM_ENABLE_VOICE;

        afterEach(() => {
            // Restore original value
            if (originalEnv === undefined) {
                delete process.env.JAMROOM_ENABLE_VOICE;
            } else {
                process.env.JAMROOM_ENABLE_VOICE = originalEnv;
            }
        });

        it('should return true when JAMROOM_ENABLE_VOICE is "true"', () => {
            process.env.JAMROOM_ENABLE_VOICE = 'true';
            expect(isVoiceEnabled()).toBe(true);
        });

        it('should return false when JAMROOM_ENABLE_VOICE is "false"', () => {
            process.env.JAMROOM_ENABLE_VOICE = 'false';
            expect(isVoiceEnabled()).toBe(false);
        });

        it('should return false when JAMROOM_ENABLE_VOICE is undefined', () => {
            delete process.env.JAMROOM_ENABLE_VOICE;
            expect(isVoiceEnabled()).toBe(false);
        });

        it('should return false for non-string "true" values', () => {
            process.env.JAMROOM_ENABLE_VOICE = '1';
            expect(isVoiceEnabled()).toBe(false);
            
            process.env.JAMROOM_ENABLE_VOICE = 'TRUE';
            expect(isVoiceEnabled()).toBe(false);
        });
    });

    describe('isVoiceMediaEnabled', () => {
        const originalVoice = process.env.JAMROOM_ENABLE_VOICE;
        const originalMedia = process.env.JAMROOM_ENABLE_VOICE_MEDIA;

        afterEach(() => {
            // Restore original values
            if (originalVoice === undefined) {
                delete process.env.JAMROOM_ENABLE_VOICE;
            } else {
                process.env.JAMROOM_ENABLE_VOICE = originalVoice;
            }
            if (originalMedia === undefined) {
                delete process.env.JAMROOM_ENABLE_VOICE_MEDIA;
            } else {
                process.env.JAMROOM_ENABLE_VOICE_MEDIA = originalMedia;
            }
        });

        it('should return true when both flags are "true"', () => {
            process.env.JAMROOM_ENABLE_VOICE = 'true';
            process.env.JAMROOM_ENABLE_VOICE_MEDIA = 'true';
            expect(isVoiceMediaEnabled()).toBe(true);
        });

        it('should return false when JAMROOM_ENABLE_VOICE is "false"', () => {
            process.env.JAMROOM_ENABLE_VOICE = 'false';
            process.env.JAMROOM_ENABLE_VOICE_MEDIA = 'true';
            expect(isVoiceMediaEnabled()).toBe(false);
        });

        it('should return false when JAMROOM_ENABLE_VOICE_MEDIA is "false"', () => {
            process.env.JAMROOM_ENABLE_VOICE = 'true';
            process.env.JAMROOM_ENABLE_VOICE_MEDIA = 'false';
            expect(isVoiceMediaEnabled()).toBe(false);
        });

        it('should return false when JAMROOM_ENABLE_VOICE_MEDIA is undefined', () => {
            process.env.JAMROOM_ENABLE_VOICE = 'true';
            delete process.env.JAMROOM_ENABLE_VOICE_MEDIA;
            expect(isVoiceMediaEnabled()).toBe(false);
        });

        it('should return false when both flags are undefined', () => {
            delete process.env.JAMROOM_ENABLE_VOICE;
            delete process.env.JAMROOM_ENABLE_VOICE_MEDIA;
            expect(isVoiceMediaEnabled()).toBe(false);
        });

        it('should require JAMROOM_ENABLE_VOICE to be enabled first', () => {
            // Media flag alone should not enable voice media
            delete process.env.JAMROOM_ENABLE_VOICE;
            process.env.JAMROOM_ENABLE_VOICE_MEDIA = 'true';
            expect(isVoiceMediaEnabled()).toBe(false);
        });
    });

    describe('attachSession', () => {
        it('should attach session ID to a participant', () => {
            joinVoice('room-1', 'user-1');
            
            const result = attachSession('room-1', 'user-1', 'session-123');
            
            expect(result.success).toBe(true);
            expect(getSessionId('room-1', 'user-1')).toBe('session-123');
        });

        it('should return error for invalid roomId', () => {
            const result = attachSession('', 'user-1', 'session-123');
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('invalid_room_id');
        });

        it('should return error for invalid userId', () => {
            const result = attachSession('room-1', '', 'session-123');
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('invalid_user_id');
        });

        it('should return error for invalid sessionId', () => {
            joinVoice('room-1', 'user-1');
            
            const result1 = attachSession('room-1', 'user-1', '');
            const result2 = attachSession('room-1', 'user-1', null);
            const result3 = attachSession('room-1', 'user-1', undefined);
            
            expect(result1.success).toBe(false);
            expect(result1.error).toBe('invalid_session_id');
            expect(result2.success).toBe(false);
            expect(result3.success).toBe(false);
        });

        it('should return error when room does not exist', () => {
            const result = attachSession('nonexistent-room', 'user-1', 'session-123');
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('room_not_found');
        });

        it('should return error when user is not in voice', () => {
            joinVoice('room-1', 'user-1');
            
            const result = attachSession('room-1', 'user-2', 'session-123');
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('user_not_in_voice');
        });

        it('should overwrite existing session ID', () => {
            joinVoice('room-1', 'user-1');
            attachSession('room-1', 'user-1', 'session-old');
            
            const result = attachSession('room-1', 'user-1', 'session-new');
            
            expect(result.success).toBe(true);
            expect(getSessionId('room-1', 'user-1')).toBe('session-new');
        });
    });

    describe('getSessionId', () => {
        it('should return session ID for a participant', () => {
            joinVoice('room-1', 'user-1');
            attachSession('room-1', 'user-1', 'session-123');
            
            expect(getSessionId('room-1', 'user-1')).toBe('session-123');
        });

        it('should return undefined for invalid roomId', () => {
            expect(getSessionId('', 'user-1')).toBeUndefined();
            expect(getSessionId(null, 'user-1')).toBeUndefined();
        });

        it('should return undefined for invalid userId', () => {
            expect(getSessionId('room-1', '')).toBeUndefined();
            expect(getSessionId('room-1', null)).toBeUndefined();
        });

        it('should return undefined when room does not exist', () => {
            expect(getSessionId('nonexistent-room', 'user-1')).toBeUndefined();
        });

        it('should return undefined when user is not in voice', () => {
            joinVoice('room-1', 'user-1');
            
            expect(getSessionId('room-1', 'user-2')).toBeUndefined();
        });

        it('should return undefined when no session was attached', () => {
            joinVoice('room-1', 'user-1');
            
            expect(getSessionId('room-1', 'user-1')).toBeUndefined();
        });
    });

    describe('getSessionsForUser', () => {
        it('should return empty array for user not in any room', () => {
            expect(getSessionsForUser('user-1')).toEqual([]);
        });

        it('should return empty array for invalid userId', () => {
            expect(getSessionsForUser('')).toEqual([]);
            expect(getSessionsForUser(null)).toEqual([]);
        });

        it('should return sessions for user in multiple rooms', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-2', 'user-1');
            joinVoice('room-3', 'user-1');
            
            attachSession('room-1', 'user-1', 'session-1');
            attachSession('room-2', 'user-1', 'session-2');
            // room-3 has no session attached
            
            const sessions = getSessionsForUser('user-1');
            
            expect(sessions).toHaveLength(2);
            expect(sessions).toContainEqual({ roomId: 'room-1', sessionId: 'session-1' });
            expect(sessions).toContainEqual({ roomId: 'room-2', sessionId: 'session-2' });
        });

        it('should only return sessions with sessionId attached', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-2', 'user-1');
            
            attachSession('room-1', 'user-1', 'session-1');
            // room-2 has no session
            
            const sessions = getSessionsForUser('user-1');
            
            expect(sessions).toHaveLength(1);
            expect(sessions[0]).toEqual({ roomId: 'room-1', sessionId: 'session-1' });
        });

        it('should not include sessions of other users', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-1', 'user-2');
            
            attachSession('room-1', 'user-1', 'session-1');
            attachSession('room-1', 'user-2', 'session-2');
            
            const sessions = getSessionsForUser('user-1');
            
            expect(sessions).toHaveLength(1);
            expect(sessions[0].sessionId).toBe('session-1');
        });

        it('should not include rooms user has left', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-2', 'user-1');
            
            attachSession('room-1', 'user-1', 'session-1');
            attachSession('room-2', 'user-1', 'session-2');
            
            leaveVoice('room-1', 'user-1');
            
            const sessions = getSessionsForUser('user-1');
            
            expect(sessions).toHaveLength(1);
            expect(sessions[0]).toEqual({ roomId: 'room-2', sessionId: 'session-2' });
        });
    });

    // ===== NEW MODERATION FUNCTIONS TESTS =====

    describe('setServerMuted', () => {
        it('should successfully server-mute a user', () => {
            joinVoice('room-1', 'user-1');
            const result = setServerMuted('room-1', 'user-1', true);
            
            expect(result.success).toBe(true);
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].serverMuted).toBe(true);
        });

        it('should successfully server-unmute a user', () => {
            joinVoice('room-1', 'user-1');
            setServerMuted('room-1', 'user-1', true);
            const result = setServerMuted('room-1', 'user-1', false);
            
            expect(result.success).toBe(true);
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].serverMuted).toBe(false);
        });

        it('should return error when room does not exist', () => {
            const result = setServerMuted('room-1', 'user-1', true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('room_not_found');
        });

        it('should return error when user is not in voice', () => {
            joinVoice('room-1', 'other-user');
            const result = setServerMuted('room-1', 'user-1', true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('user_not_in_voice');
        });

        it('should return error for invalid roomId', () => {
            const result = setServerMuted('', 'user-1', true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('invalid_room_id');
        });

        it('should return error for invalid userId', () => {
            joinVoice('room-1', 'user-1');
            const result = setServerMuted('room-1', '', true);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('invalid_user_id');
        });

        it('should return error for invalid serverMuted value', () => {
            joinVoice('room-1', 'user-1');
            const result = setServerMuted('room-1', 'user-1', 'true');
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('invalid_server_muted_value');
        });

        it('should not affect self-mute state', () => {
            joinVoice('room-1', 'user-1');
            setMute('room-1', 'user-1', true);
            setServerMuted('room-1', 'user-1', true);
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].muted).toBe(true);  // self-mute unchanged
            expect(state.participants[0].serverMuted).toBe(true);  // server-mute applied
        });
    });

    describe('setRole', () => {
        it('should successfully set role to host', () => {
            joinVoice('room-1', 'user-1');
            const result = setRole('room-1', 'user-1', 'host');
            
            expect(result.success).toBe(true);
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].role).toBe('host');
        });

        it('should successfully set role to cohost', () => {
            joinVoice('room-1', 'user-1');
            const result = setRole('room-1', 'user-1', 'cohost');
            
            expect(result.success).toBe(true);
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].role).toBe('cohost');
        });

        it('should successfully set role to speaker', () => {
            joinVoice('room-1', 'user-1');
            const result = setRole('room-1', 'user-1', 'speaker');
            
            expect(result.success).toBe(true);
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].role).toBe('speaker');
        });

        it('should successfully set role to listener', () => {
            joinVoice('room-1', 'user-1');
            const result = setRole('room-1', 'user-1', 'listener');
            
            expect(result.success).toBe(true);
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].role).toBe('listener');
        });

        it('should return error for invalid role', () => {
            joinVoice('room-1', 'user-1');
            const result = setRole('room-1', 'user-1', 'admin');
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('invalid_role');
        });

        it('should return error when room does not exist', () => {
            const result = setRole('room-1', 'user-1', 'host');
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('room_not_found');
        });

        it('should return error when user is not in voice', () => {
            joinVoice('room-1', 'other-user');
            const result = setRole('room-1', 'user-1', 'host');
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('user_not_in_voice');
        });

        it('should return error for invalid roomId', () => {
            const result = setRole('', 'user-1', 'host');
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('invalid_room_id');
        });
    });

    describe('getParticipant', () => {
        it('should return participant data', () => {
            joinVoice('room-1', 'user-1', { role: 'host', canPublishAudio: true });
            attachSession('room-1', 'user-1', 'session-123');
            
            const participant = getParticipant('room-1', 'user-1');
            
            expect(participant).toBeDefined();
            expect(participant.userId).toBe('user-1');
            expect(participant.role).toBe('host');
            expect(participant.canPublishAudio).toBe(true);
            expect(participant.sessionId).toBe('session-123');
        });

        it('should return null for user not in voice', () => {
            const participant = getParticipant('room-1', 'user-1');
            
            expect(participant).toBeNull();
        });

        it('should return null for invalid roomId', () => {
            const participant = getParticipant('', 'user-1');
            
            expect(participant).toBeNull();
        });

        it('should return null for invalid userId', () => {
            joinVoice('room-1', 'user-1');
            const participant = getParticipant('room-1', '');
            
            expect(participant).toBeNull();
        });
    });

    describe('setCanPublishAudio', () => {
        it('should successfully set canPublishAudio to false', () => {
            joinVoice('room-1', 'user-1');
            const result = setCanPublishAudio('room-1', 'user-1', false);
            
            expect(result.success).toBe(true);
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].canPublishAudio).toBe(false);
        });

        it('should successfully set canPublishAudio to true', () => {
            joinVoice('room-1', 'user-1', { canPublishAudio: false });
            const result = setCanPublishAudio('room-1', 'user-1', true);
            
            expect(result.success).toBe(true);
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].canPublishAudio).toBe(true);
        });

        it('should return error when room does not exist', () => {
            const result = setCanPublishAudio('room-1', 'user-1', false);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('room_not_found');
        });

        it('should return error when user is not in voice', () => {
            joinVoice('room-1', 'other-user');
            const result = setCanPublishAudio('room-1', 'user-1', false);
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('user_not_in_voice');
        });

        it('should return error for invalid value', () => {
            joinVoice('room-1', 'user-1');
            const result = setCanPublishAudio('room-1', 'user-1', 'false');
            
            expect(result.success).toBe(false);
            expect(result.error).toBe('invalid_can_publish_audio_value');
        });
    });

    describe('countSpeakers', () => {
        it('should return 0 for empty room', () => {
            const count = countSpeakers('room-1');
            
            expect(count).toBe(0);
        });

        it('should count participants with canPublishAudio=true', () => {
            joinVoice('room-1', 'user-1', { canPublishAudio: true });
            joinVoice('room-1', 'user-2', { canPublishAudio: true });
            joinVoice('room-1', 'user-3', { canPublishAudio: false });
            
            const count = countSpeakers('room-1');
            
            expect(count).toBe(2);
        });

        it('should return 0 for invalid roomId', () => {
            const count = countSpeakers('');
            
            expect(count).toBe(0);
        });

        it('should update when canPublishAudio changes', () => {
            joinVoice('room-1', 'user-1');
            joinVoice('room-1', 'user-2');
            
            expect(countSpeakers('room-1')).toBe(2);  // Both default to canPublishAudio: true
            
            setCanPublishAudio('room-1', 'user-1', false);
            
            expect(countSpeakers('room-1')).toBe(1);
        });
    });

    describe('joinVoice with options', () => {
        it('should accept role option', () => {
            const result = joinVoice('room-1', 'user-1', { role: 'host' });
            
            expect(result.success).toBe(true);
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].role).toBe('host');
        });

        it('should accept canPublishAudio option', () => {
            const result = joinVoice('room-1', 'user-1', { canPublishAudio: false });
            
            expect(result.success).toBe(true);
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].canPublishAudio).toBe(false);
        });

        it('should use default values when options not provided', () => {
            joinVoice('room-1', 'user-1');
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].canPublishAudio).toBe(true);
            expect(state.participants[0].role).toBeUndefined();
        });

        it('should be backward compatible (no options)', () => {
            const result = joinVoice('room-1', 'user-1');
            
            expect(result.success).toBe(true);
            
            const state = getVoiceState('room-1');
            expect(state.participants[0].userId).toBe('user-1');
            expect(state.participants[0].muted).toBe(false);
        });
    });
});
