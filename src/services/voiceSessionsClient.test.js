/**
 * Unit tests for voiceSessionsClient
 */

import { jest } from '@jest/globals';

// Mock fetch globally before importing the client
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Store original env
const originalEnv = { ...process.env };

describe('voiceSessionsClient', () => {
    let createOrUpdateVoiceSession;
    let deleteVoiceSession;
    let listVoiceSessionsByRoom;
    let getOperationMetrics;
    let getAllMetrics;
    let resetMetrics;
    let VoiceServiceError;
    let consoleLogSpy;
    let consoleErrorSpy;
    let consoleWarnSpy;

    beforeEach(async () => {
        // Reset modules to get fresh config
        jest.resetModules();
        mockFetch.mockReset();
        
        // Set default env
        process.env.VOICE_SERVICE_BASE_URL = 'http://localhost:3002';
        process.env.VOICE_SERVICE_TIMEOUT_MS = '4000';
        
        // Spy on console methods
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        
        // Re-import to get fresh module with new env
        const client = await import('./voiceSessionsClient.js');
        createOrUpdateVoiceSession = client.createOrUpdateVoiceSession;
        deleteVoiceSession = client.deleteVoiceSession;
        listVoiceSessionsByRoom = client.listVoiceSessionsByRoom;
        getOperationMetrics = client.getOperationMetrics;
        getAllMetrics = client.getAllMetrics;
        resetMetrics = client.resetMetrics;
        VoiceServiceError = client.voiceSessionsClient.VoiceServiceError;
        
        // Reset metrics for clean state
        resetMetrics();
    });

    afterEach(() => {
        // Restore original env
        process.env = { ...originalEnv };
        jest.restoreAllMocks();
    });

    describe('createOrUpdateVoiceSession', () => {
        const mockVoiceSession = {
            sessionId: 'session-123',
            roomId: 'room-1',
            userId: 'user-1',
            username: 'testuser',
            canPublishAudio: true,
            canSubscribe: true,
            livekit: {
                token: 'livekit-token-abc',
                wsUrl: 'wss://livekit.example.com',
            },
            createdAt: '2025-12-01T00:00:00Z',
            updatedAt: '2025-12-01T00:00:00Z',
        };

        it('should return VoiceSession on successful POST 201', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 201,
                json: async () => ({ data: mockVoiceSession }),
            });

            const result = await createOrUpdateVoiceSession({
                roomId: 'room-1',
                userId: 'user-1',
                username: 'testuser',
                canPublishAudio: true,
                canSubscribe: true,
            });

            expect(result).toEqual(mockVoiceSession);
            expect(mockFetch).toHaveBeenCalledWith(
                'http://localhost:3002/api/v1/voice/sessions',
                expect.objectContaining({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        roomId: 'room-1',
                        userId: 'user-1',
                        username: 'testuser',
                        canPublishAudio: true,
                        canSubscribe: true,
                    }),
                })
            );
        });

        it('should return VoiceSession on successful POST 200', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ data: mockVoiceSession }),
            });

            const result = await createOrUpdateVoiceSession({
                roomId: 'room-1',
                userId: 'user-1',
            });

            expect(result).toEqual(mockVoiceSession);
        });

        it('should throw VOICE_SERVICE_UNAVAILABLE on 500 response', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: async () => 'Internal Server Error',
            });

            await expect(
                createOrUpdateVoiceSession({
                    roomId: 'room-1',
                    userId: 'user-1',
                })
            ).rejects.toMatchObject({
                code: 'VOICE_SERVICE_UNAVAILABLE',
            });
        });

        it('should throw VOICE_INTERNAL_ERROR on 400 response', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 400,
                text: async () => 'Bad Request',
            });

            await expect(
                createOrUpdateVoiceSession({
                    roomId: 'room-1',
                    userId: 'user-1',
                })
            ).rejects.toMatchObject({
                code: 'VOICE_INTERNAL_ERROR',
            });
        });

        it('should throw VOICE_SERVICE_UNAVAILABLE when baseUrl not configured', async () => {
            jest.resetModules();
            delete process.env.VOICE_SERVICE_BASE_URL;
            
            const client = await import('./voiceSessionsClient.js');
            
            await expect(
                client.createOrUpdateVoiceSession({
                    roomId: 'room-1',
                    userId: 'user-1',
                })
            ).rejects.toMatchObject({
                code: 'VOICE_SERVICE_UNAVAILABLE',
            });
        });

        it('should handle network errors', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            await expect(
                createOrUpdateVoiceSession({
                    roomId: 'room-1',
                    userId: 'user-1',
                })
            ).rejects.toMatchObject({
                code: 'VOICE_INTERNAL_ERROR',
            });
        });

        it('should handle timeout errors', async () => {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            mockFetch.mockRejectedValueOnce(abortError);

            await expect(
                createOrUpdateVoiceSession({
                    roomId: 'room-1',
                    userId: 'user-1',
                })
            ).rejects.toMatchObject({
                code: 'VOICE_SERVICE_TIMEOUT',
            });
        });
    });

    describe('deleteVoiceSession', () => {
        it('should return true on 204 response', async () => {
            mockFetch.mockResolvedValueOnce({
                status: 204,
            });

            const result = await deleteVoiceSession('session-123');

            expect(result).toBe(true);
            expect(mockFetch).toHaveBeenCalledWith(
                'http://localhost:3002/api/v1/voice/sessions/session-123',
                expect.objectContaining({
                    method: 'DELETE',
                })
            );
        });

        it('should return false on 404 response', async () => {
            mockFetch.mockResolvedValueOnce({
                status: 404,
            });

            const result = await deleteVoiceSession('session-123');

            expect(result).toBe(false);
        });

        it('should return false on other errors (no throw)', async () => {
            mockFetch.mockResolvedValueOnce({
                status: 500,
                text: async () => 'Server Error',
            });

            const result = await deleteVoiceSession('session-123');

            expect(result).toBe(false);
        });

        it('should return false when baseUrl not configured (no throw)', async () => {
            jest.resetModules();
            delete process.env.VOICE_SERVICE_BASE_URL;
            
            const client = await import('./voiceSessionsClient.js');
            
            const result = await client.deleteVoiceSession('session-123');
            
            expect(result).toBe(false);
        });

        it('should return false on network error (no throw)', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            const result = await deleteVoiceSession('session-123');

            expect(result).toBe(false);
        });

        it('should return false on timeout (no throw)', async () => {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            mockFetch.mockRejectedValueOnce(abortError);

            const result = await deleteVoiceSession('session-123');

            expect(result).toBe(false);
        });
    });

    describe('listVoiceSessionsByRoom', () => {
        const mockSessions = [
            { sessionId: 'session-1', userId: 'user-1', roomId: 'room-1' },
            { sessionId: 'session-2', userId: 'user-2', roomId: 'room-1' },
        ];

        it('should return sessions array on 200 response', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ data: mockSessions }),
            });

            const result = await listVoiceSessionsByRoom('room-1');

            expect(result).toEqual(mockSessions);
            expect(mockFetch).toHaveBeenCalledWith(
                'http://localhost:3002/api/v1/voice/rooms/room-1/sessions',
                expect.objectContaining({
                    method: 'GET',
                })
            );
        });

        it('should return empty array on 404 response', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
            });

            const result = await listVoiceSessionsByRoom('room-1');

            expect(result).toEqual([]);
        });

        it('should throw VOICE_SERVICE_UNAVAILABLE on 500 response', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: async () => 'Server Error',
            });

            await expect(
                listVoiceSessionsByRoom('room-1', { noRetry: true })
            ).rejects.toMatchObject({
                code: 'VOICE_SERVICE_UNAVAILABLE',
            });
        });

        it('should return empty array when baseUrl not configured (no throw)', async () => {
            jest.resetModules();
            delete process.env.VOICE_SERVICE_BASE_URL;
            
            const client = await import('./voiceSessionsClient.js');
            
            const result = await client.listVoiceSessionsByRoom('room-1');
            
            expect(result).toEqual([]);
        });

        it('should handle network errors', async () => {
            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            await expect(
                listVoiceSessionsByRoom('room-1', { noRetry: true })
            ).rejects.toMatchObject({
                code: 'VOICE_INTERNAL_ERROR',
            });
        });

        it('should handle timeout errors', async () => {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            mockFetch.mockRejectedValueOnce(abortError);

            await expect(
                listVoiceSessionsByRoom('room-1', { noRetry: true })
            ).rejects.toMatchObject({
                code: 'VOICE_SERVICE_TIMEOUT',
            });
        });

        it('should URL-encode room IDs with special characters', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ data: [] }),
            });

            await listVoiceSessionsByRoom('room/with/slashes');

            expect(mockFetch).toHaveBeenCalledWith(
                'http://localhost:3002/api/v1/voice/rooms/room%2Fwith%2Fslashes/sessions',
                expect.anything()
            );
        });

        it('should retry on transient failure and succeed on second attempt', async () => {
            // First call fails with 500
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: async () => 'Server Error',
            });
            // Second call succeeds
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    data: [
                        { sessionId: 'session-1', roomId: 'room-1', userId: 'user-1' },
                    ],
                }),
            });

            const result = await listVoiceSessionsByRoom('room-1');

            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(result).toHaveLength(1);
            expect(result[0].sessionId).toBe('session-1');
        });

        it('should NOT retry when noRetry option is true', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: async () => 'Server Error',
            });

            await expect(
                listVoiceSessionsByRoom('room-1', { noRetry: true })
            ).rejects.toMatchObject({
                code: 'VOICE_SERVICE_UNAVAILABLE',
            });

            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('should NOT retry on 4xx client errors', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 400,
                text: async () => 'Bad Request',
            });

            await expect(listVoiceSessionsByRoom('room-1')).rejects.toMatchObject({
                code: 'VOICE_INTERNAL_ERROR',
            });

            expect(mockFetch).toHaveBeenCalledTimes(1);
        });
    });

    // =========================================================================
    // METRICS TESTS
    // =========================================================================

    describe('Metrics', () => {
        it('should track success metrics for createOrUpdateVoiceSession', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 201,
                json: async () => ({
                    data: {
                        sessionId: 'session-123',
                        roomId: 'room-1',
                        userId: 'user-1',
                    },
                }),
            });

            await createOrUpdateVoiceSession({
                roomId: 'room-1',
                userId: 'user-1',
            });

            const metrics = getOperationMetrics('create_or_update');
            expect(metrics).not.toBeNull();
            expect(metrics.successCount).toBe(1);
            expect(metrics.errorCount).toBe(0);
            expect(metrics.avgLatencyMs).toBeGreaterThanOrEqual(0);
        });

        it('should track error metrics for createOrUpdateVoiceSession on failure', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: async () => 'Server Error',
            });

            await expect(
                createOrUpdateVoiceSession({ roomId: 'room-1', userId: 'user-1' })
            ).rejects.toThrow();

            const metrics = getOperationMetrics('create_or_update');
            expect(metrics.successCount).toBe(0);
            expect(metrics.errorCount).toBe(1);
        });

        it('should track success metrics for deleteVoiceSession', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 204,
            });

            await deleteVoiceSession('session-123');

            const metrics = getOperationMetrics('delete');
            expect(metrics.successCount).toBe(1);
            expect(metrics.errorCount).toBe(0);
        });

        it('should track success metrics for listVoiceSessionsByRoom', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ data: [] }),
            });

            await listVoiceSessionsByRoom('room-1');

            const metrics = getOperationMetrics('list');
            expect(metrics.successCount).toBe(1);
            expect(metrics.errorCount).toBe(0);
        });

        it('should aggregate metrics across multiple calls', async () => {
            // 3 successful calls
            for (let i = 0; i < 3; i++) {
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    status: 204,
                });
                await deleteVoiceSession(`session-${i}`);
            }

            // 1 error call
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: async () => 'Error',
            });
            await deleteVoiceSession('session-fail');

            const metrics = getOperationMetrics('delete');
            expect(metrics.successCount).toBe(3);
            expect(metrics.errorCount).toBe(1);
        });

        it('should return all metrics with getAllMetrics', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 201,
                json: async () => ({ data: { sessionId: 'sess' } }),
            });
            await createOrUpdateVoiceSession({ roomId: 'r', userId: 'u' });

            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 204,
            });
            await deleteVoiceSession('sess');

            const all = getAllMetrics();
            expect(all).toHaveProperty('create_or_update');
            expect(all).toHaveProperty('delete');
        });

        it('should return null for non-existent operation metrics', () => {
            const metrics = getOperationMetrics('nonexistent_operation');
            expect(metrics).toBeNull();
        });

        it('should reset metrics correctly', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 204,
            });
            await deleteVoiceSession('session-123');

            expect(getOperationMetrics('delete').successCount).toBe(1);

            resetMetrics();

            expect(getOperationMetrics('delete')).toBeNull();
        });
    });

    // =========================================================================
    // STRUCTURED LOGGING TESTS
    // =========================================================================

    describe('Structured Logging', () => {
        it('should log success with structured format for createOrUpdateVoiceSession', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 201,
                json: async () => ({
                    data: {
                        sessionId: 'session-xyz',
                        roomId: 'room-1',
                        userId: 'user-1',
                    },
                }),
            });

            await createOrUpdateVoiceSession({
                roomId: 'room-1',
                userId: 'user-1',
            });

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[voice-client\] op=create_or_update status=success room=room-1 user=user-1 session=session-xyz latency_ms=\d+/)
            );
        });

        it('should log error with status=error for createOrUpdateVoiceSession on failure', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: async () => 'Internal Server Error',
            });

            await expect(
                createOrUpdateVoiceSession({ roomId: 'room-1', userId: 'user-1' })
            ).rejects.toThrow();

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[voice-client\] op=create_or_update status=error room=room-1 user=user-1 latency_ms=\d+ error=HTTP 500/)
            );
        });

        it('should log timeout error with structured format', async () => {
            const abortError = new Error('Aborted');
            abortError.name = 'AbortError';
            mockFetch.mockRejectedValueOnce(abortError);

            await expect(
                createOrUpdateVoiceSession({ roomId: 'room-1', userId: 'user-1' })
            ).rejects.toThrow();

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[voice-client\] op=create_or_update status=error room=room-1 user=user-1 latency_ms=\d+ error=timeout/)
            );
        });

        it('should log success with structured format for deleteVoiceSession', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 204,
            });

            await deleteVoiceSession('session-123');

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[voice-client\] op=delete status=success session=session-123 latency_ms=\d+/)
            );
        });

        it('should log not_found status for deleteVoiceSession 404', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
            });

            await deleteVoiceSession('session-notfound');

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[voice-client\] op=delete status=not_found session=session-notfound latency_ms=\d+/)
            );
        });

        it('should log error with status=error for deleteVoiceSession on 500', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: async () => 'Error',
            });

            await deleteVoiceSession('session-fail');

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[voice-client\] op=delete status=error session=session-fail latency_ms=\d+ error=HTTP 500/)
            );
        });

        it('should log success with structured format for listVoiceSessionsByRoom', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ data: [] }),
            });

            await listVoiceSessionsByRoom('room-1');

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[voice-client\] op=list status=success room=room-1 latency_ms=\d+/)
            );
        });

        it('should log error with status=error for listVoiceSessionsByRoom on failure', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: false,
                status: 500,
                text: async () => 'Server Error',
            });

            await expect(
                listVoiceSessionsByRoom('room-1', { noRetry: true })
            ).rejects.toThrow();

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[voice-client\] op=list status=error room=room-1 latency_ms=\d+ error=HTTP 500/)
            );
        });

        it('should log warning when service is not configured', async () => {
            jest.resetModules();
            delete process.env.VOICE_SERVICE_BASE_URL;
            
            // Need to set up fresh spies after resetModules
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            
            const client = await import('./voiceSessionsClient.js');
            
            await client.listVoiceSessionsByRoom('room-1');

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringMatching(/\[voice-client\] op=list status=skipped room=room-1 error=service_not_configured/)
            );
            
            warnSpy.mockRestore();
        });

        it('should include requestId in logs when provided', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 201,
                json: async () => ({
                    data: {
                        sessionId: 'session-abc',
                        roomId: 'room-1',
                        userId: 'user-1',
                    },
                }),
            });

            await createOrUpdateVoiceSession({
                roomId: 'room-1',
                userId: 'user-1',
                requestId: 'req-12345',
            });

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringMatching(/request_id=req-12345/)
            );
        });

        it('should include socketId in logs when provided via log function', async () => {
            // The socketId is typically passed through syncGateway logs,
            // but voiceSessionsClient.log supports it as well
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 204,
            });

            await deleteVoiceSession('session-123', { requestId: 'ws-req-001' });

            // Verify the request_id is logged (socketId would be added by caller in syncGateway)
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringMatching(/request_id=ws-req-001/)
            );
        });
    });

    // =========================================================================
    // INTERNAL API KEY HEADER TESTS
    // =========================================================================

    describe('Internal API Key Header', () => {
        const mockVoiceSession = {
            sessionId: 'session-123',
            roomId: 'room-1',
            userId: 'user-1',
            livekit: { token: 'token', wsUrl: 'wss://test.livekit.cloud' },
        };

        beforeEach(async () => {
            // Reset modules to get fresh config with API key
            jest.resetModules();
            mockFetch.mockReset();
            
            // Set env with INTERNAL_API_KEY
            process.env.VOICE_SERVICE_BASE_URL = 'http://localhost:3002';
            process.env.VOICE_SERVICE_TIMEOUT_MS = '4000';
            process.env.INTERNAL_API_KEY = 'test-internal-api-key-12345';
            
            // Re-import to get fresh module with new env
            const client = await import('./voiceSessionsClient.js');
            createOrUpdateVoiceSession = client.createOrUpdateVoiceSession;
            deleteVoiceSession = client.deleteVoiceSession;
            listVoiceSessionsByRoom = client.listVoiceSessionsByRoom;
            resetMetrics = client.resetMetrics;
            
            resetMetrics();
        });

        it('should include x-internal-api-key header in createOrUpdateVoiceSession', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 201,
                json: async () => ({ data: mockVoiceSession }),
            });

            await createOrUpdateVoiceSession({
                roomId: 'room-1',
                userId: 'user-1',
            });

            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'x-internal-api-key': 'test-internal-api-key-12345',
                    }),
                })
            );
        });

        it('should include x-internal-api-key header in deleteVoiceSession', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 204,
            });

            await deleteVoiceSession('session-123');

            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'x-internal-api-key': 'test-internal-api-key-12345',
                    }),
                })
            );
        });

        it('should include x-internal-api-key header in listVoiceSessionsByRoom', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({ data: [] }),
            });

            await listVoiceSessionsByRoom('room-1');

            expect(mockFetch).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        'x-internal-api-key': 'test-internal-api-key-12345',
                    }),
                })
            );
        });

        it('should NOT include x-internal-api-key header when INTERNAL_API_KEY is not set', async () => {
            // Reset without the API key
            jest.resetModules();
            mockFetch.mockReset();
            
            process.env.VOICE_SERVICE_BASE_URL = 'http://localhost:3002';
            process.env.VOICE_SERVICE_TIMEOUT_MS = '4000';
            delete process.env.INTERNAL_API_KEY;
            
            const client = await import('./voiceSessionsClient.js');
            const create = client.createOrUpdateVoiceSession;
            client.resetMetrics();
            
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 201,
                json: async () => ({ data: mockVoiceSession }),
            });

            await create({ roomId: 'room-1', userId: 'user-1' });

            const callArgs = mockFetch.mock.calls[0][1];
            expect(callArgs.headers).not.toHaveProperty('x-internal-api-key');
        });
    });
});
