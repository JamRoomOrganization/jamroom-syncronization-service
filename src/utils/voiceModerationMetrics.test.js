/**
 * Unit tests for voiceModerationMetrics module
 */

import { jest } from '@jest/globals';

import {
    recordModerationEventReceived,
    recordModerationSuccess,
    recordModerationError,
    getModerationMetrics,
    getAllModerationMetrics,
    getModerationMetricsSummary,
    resetModerationMetrics,
    logModeration,
} from './voiceModerationMetrics.js';

describe('voiceModerationMetrics', () => {
    beforeEach(() => {
        resetModerationMetrics();
    });

    describe('recordModerationEventReceived', () => {
        it('should increment received counter for event type', () => {
            recordModerationEventReceived('host-mute');
            recordModerationEventReceived('host-mute');
            recordModerationEventReceived('host-unmute');

            const muteMetrics = getModerationMetrics('host-mute');
            const unmuteMetrics = getModerationMetrics('host-unmute');

            expect(muteMetrics.received).toBe(2);
            expect(unmuteMetrics.received).toBe(1);
        });
    });

    describe('recordModerationSuccess', () => {
        it('should increment success counter for event type', () => {
            recordModerationEventReceived('host-mute');
            recordModerationSuccess('host-mute');
            recordModerationSuccess('host-mute');

            const metrics = getModerationMetrics('host-mute');

            expect(metrics.success).toBe(2);
        });
    });

    describe('recordModerationError', () => {
        it('should increment error counter and specific error type', () => {
            recordModerationEventReceived('host-kick');
            recordModerationError('host-kick', 'permission_denied');
            recordModerationError('host-kick', 'voice_service_error');
            recordModerationError('host-kick', 'target_not_in_voice');

            const metrics = getModerationMetrics('host-kick');

            expect(metrics.error).toBe(3);
            expect(metrics.permissionDenied).toBe(1);
            expect(metrics.voiceServiceError).toBe(1);
            expect(metrics.targetNotInVoice).toBe(1);
        });

        it('should handle generic "other" error type', () => {
            recordModerationEventReceived('host-mute');
            recordModerationError('host-mute', 'other');

            const metrics = getModerationMetrics('host-mute');

            expect(metrics.error).toBe(1);
            expect(metrics.permissionDenied).toBe(0);
        });
    });

    describe('getModerationMetrics', () => {
        it('should return null for non-existent event type', () => {
            const metrics = getModerationMetrics('non-existent');

            expect(metrics).toBeNull();
        });

        it('should return metrics for existing event type', () => {
            recordModerationEventReceived('host-mute');
            recordModerationSuccess('host-mute');

            const metrics = getModerationMetrics('host-mute');

            expect(metrics).toEqual({
                received: 1,
                success: 1,
                error: 0,
                permissionDenied: 0,
                targetNotInVoice: 0,
                voiceServiceError: 0,
            });
        });
    });

    describe('getAllModerationMetrics', () => {
        it('should return empty object when no metrics recorded', () => {
            const allMetrics = getAllModerationMetrics();

            expect(allMetrics).toEqual({});
        });

        it('should return all recorded metrics', () => {
            recordModerationEventReceived('host-mute');
            recordModerationEventReceived('host-unmute');
            recordModerationSuccess('host-mute');
            recordModerationError('host-unmute', 'permission_denied');

            const allMetrics = getAllModerationMetrics();

            expect(Object.keys(allMetrics)).toHaveLength(2);
            expect(allMetrics['host-mute'].success).toBe(1);
            expect(allMetrics['host-unmute'].permissionDenied).toBe(1);
        });
    });

    describe('getModerationMetricsSummary', () => {
        it('should return summary with totals', () => {
            recordModerationEventReceived('host-mute');
            recordModerationEventReceived('host-mute');
            recordModerationEventReceived('host-kick');
            recordModerationSuccess('host-mute');
            recordModerationSuccess('host-mute');
            recordModerationError('host-kick', 'voice_service_error');

            const summary = getModerationMetricsSummary();

            expect(summary.totalReceived).toBe(3);
            expect(summary.totalSuccess).toBe(2);
            expect(summary.totalError).toBe(1);
            expect(summary.successRate).toBe('66.67%');
            expect(Object.keys(summary.byType)).toHaveLength(2);
        });

        it('should handle zero events gracefully', () => {
            const summary = getModerationMetricsSummary();

            expect(summary.totalReceived).toBe(0);
            expect(summary.successRate).toBe('N/A');
        });
    });

    describe('resetModerationMetrics', () => {
        it('should clear all metrics', () => {
            recordModerationEventReceived('host-mute');
            recordModerationEventReceived('host-unmute');
            recordModerationSuccess('host-mute');

            resetModerationMetrics();

            expect(getAllModerationMetrics()).toEqual({});
            expect(getModerationMetrics('host-mute')).toBeNull();
        });
    });

    describe('logModeration', () => {
        let consoleLogSpy;
        let consoleWarnSpy;
        let consoleErrorSpy;

        beforeEach(() => {
            consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        });

        afterEach(() => {
            jest.restoreAllMocks();
        });

        it('should log with [voice-moderation] prefix', () => {
            logModeration('info', {
                type: 'host-mute',
                result: 'success',
                roomId: 'room-1',
                targetUserId: 'user-2',
                moderatorUserId: 'user-1',
            });

            expect(consoleLogSpy).toHaveBeenCalled();
            const logMessage = consoleLogSpy.mock.calls[0][0];
            expect(logMessage).toContain('[voice-moderation]');
            expect(logMessage).toContain('type=host-mute');
            expect(logMessage).toContain('result=success');
            expect(logMessage).toContain('room=room-1');
            expect(logMessage).toContain('target=user-2');
            expect(logMessage).toContain('moderator=user-1');
        });

        it('should use console.warn for warn level', () => {
            logModeration('warn', {
                type: 'host-mute',
                result: 'permission_denied',
                roomId: 'room-1',
            });

            expect(consoleWarnSpy).toHaveBeenCalled();
        });

        it('should use console.error for error level', () => {
            logModeration('error', {
                type: 'host-kick',
                result: 'voice_service_error',
                roomId: 'room-1',
                error: 'Connection timeout',
            });

            expect(consoleErrorSpy).toHaveBeenCalled();
            const logMessage = consoleErrorSpy.mock.calls[0][0];
            expect(logMessage).toContain('error=Connection timeout');
        });

        it('should include all optional fields when provided', () => {
            logModeration('info', {
                type: 'host-mute',
                result: 'success',
                roomId: 'room-1',
                targetUserId: 'user-2',
                moderatorUserId: 'user-1',
                requestId: 'ws-12345',
                socketId: 'socket-abc',
                latencyMs: 42,
                reason: 'spamming',
            });

            const logMessage = consoleLogSpy.mock.calls[0][0];
            expect(logMessage).toContain('request_id=ws-12345');
            expect(logMessage).toContain('socket_id=socket-abc');
            expect(logMessage).toContain('latency_ms=42');
            expect(logMessage).toContain('reason=spamming');
        });

        it('should omit undefined fields', () => {
            logModeration('info', {
                type: 'host-unmute',
                result: 'success',
                roomId: 'room-1',
            });

            const logMessage = consoleLogSpy.mock.calls[0][0];
            expect(logMessage).not.toContain('target=');
            expect(logMessage).not.toContain('moderator=');
            expect(logMessage).not.toContain('request_id=');
        });
    });
});
