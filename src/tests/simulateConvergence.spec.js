import { describe, it, expect } from '@jest/globals';
import { decideCorrection } from '../utils/driftLogic.js';

/**
 * Helper to compute the authoritative server position. Mirrors the logic used by the gateway:
 * position = basePositionMs + (nowServerMs - baseServerTimeMs)
 */
const createServerTimeline = ({ basePositionMs, baseServerTimeMs }) => ({
    basePositionMs,
    baseServerTimeMs,
    positionAt(nowMs) {
        return this.basePositionMs + (nowMs - this.baseServerTimeMs);
    },
});

/**
 * Minimal virtual client that mimics a playback engine reacting to rateAdjust/seek commands.
 * - advance() moves the local playback head according to the current playbackRate.
 * - applyRateAdjust() changes playbackRate temporarily (until the provided deadline).
 * - applySeek() snaps the playback head to the requested position and resets playbackRate.
 */
class FakeClient {
    constructor({ label, initialPositionMs, networkLagMs, jitterMs = 0 }) {
        this.label = label;
        this.localPosMs = initialPositionMs;
        this.playbackRate = 1.0;
        this.networkLagMs = networkLagMs;
        this.jitterMs = jitterMs;
        this.rateAdjustUntilMs = 0;
    }

    advance(nowMs, deltaMs) {
        if (nowMs >= this.rateAdjustUntilMs) {
            this.playbackRate = 1;
        }
        this.localPosMs += deltaMs * this.playbackRate;
    }

    applyRateAdjust(playbackRate, durationMs, nowMs) {
        this.playbackRate = playbackRate;
        this.rateAdjustUntilMs = nowMs + durationMs;
    }

    applySeek(positionMs) {
        this.localPosMs = positionMs;
        this.playbackRate = 1;
        this.rateAdjustUntilMs = 0;
    }
}

describe('convergence', () => {
    it('clients converge under 100ms drift', () => {
        // Assumptions for the simulation:
        // - The server emits syncPackets roughly every second.
        // - Clients immediately apply rateAdjust/seek instructions for the next tick.
        // - PlaybackRate tweaks correct medium drift gradually; seek corrects large drift instantly.
        // - Network lag is modest (dozens of ms) and we ignore extreme jitter to focus on convergence logic.

        const server = createServerTimeline({
            basePositionMs: 0,
            baseServerTimeMs: 0,
        });

        const tickMs = 1000;
        let nowServerMs = 0;

        const serverPosAtStart = server.positionAt(nowServerMs);

        const clients = [
            new FakeClient({
                label: 'fast',
                initialPositionMs: serverPosAtStart,
                networkLagMs: 20,
            }),
            new FakeClient({
                label: 'medium',
                initialPositionMs: serverPosAtStart + 80, // 80ms ahead
                networkLagMs: 50,
            }),
            new FakeClient({
                label: 'bad',
                initialPositionMs: serverPosAtStart - 180, // 180ms behind
                networkLagMs: 120,
            }),
        ];

        const iterations = 5; // ~5 seconds of simulated time

        for (let i = 0; i < iterations; i += 1) {
            nowServerMs += tickMs;

            // 1) Advance every client according to its current playback rate.
            clients.forEach((client) => {
                client.advance(nowServerMs, tickMs);
            });

            // 2) Each client sends a driftReport based on what it "observed" (accounting for network lag).
            clients.forEach((client) => {
                const observedServerTimeMs = nowServerMs - client.networkLagMs;
                const observedServerPositionMs = server.positionAt(observedServerTimeMs);

                const decision = decideCorrection({
                    localPositionMs: client.localPosMs,
                    observedServerPositionMs,
                    observedServerTimeMs,
                    nowServerMs,
                    jitterMs: client.jitterMs,
                    clientLagMs: client.networkLagMs,
                });

                if (decision.action === 'rate') {
                    client.applyRateAdjust(
                        decision.payload.playbackRate,
                        decision.payload.durationMs,
                        nowServerMs,
                    );
                } else if (decision.action === 'seek') {
                    client.applySeek(decision.payload.positionMs);
                }
                // action === 'ignore' -> do nothing
            });
        }

        const finalServerPosition = server.positionAt(nowServerMs);

        clients.forEach((client) => {
            const finalDrift = Math.abs(client.localPosMs - finalServerPosition);
            expect(finalDrift).toBeLessThanOrEqual(100);
        });
    });
});
