import { describe, it, expect } from '@jest/globals';
import { decideCorrection } from '../utils/driftLogic.js';

const createServerTimeline = ({ basePositionMs, baseServerTimeMs }) => ({
    basePositionMs,
    baseServerTimeMs,
    positionAt(nowMs) {
        return this.basePositionMs + (nowMs - this.baseServerTimeMs);
    },
});

class FakeClient {
    constructor({ label, initialPositionMs, networkLagMs, jitterMs }) {
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

describe('convergence under high jitter', () => {
    it('keeps high jitter clients within reasonable drift without repeated hard seeks', () => {
        // High jitter connections should receive more gentle corrections (rate before seek).
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
                jitterMs: 20,
            }),
            new FakeClient({
                label: 'medium',
                initialPositionMs: serverPosAtStart + 70,
                networkLagMs: 60,
                jitterMs: 50,
            }),
            new FakeClient({
                label: 'bad',
                initialPositionMs: serverPosAtStart - 180,
                networkLagMs: 120,
                jitterMs: 200,
            }),
        ];

        const iterations = 5;

        for (let i = 0; i < iterations; i += 1) {
            nowServerMs += tickMs;

            clients.forEach((client) => {
                client.advance(nowServerMs, tickMs);
            });

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
            });
        }

        const finalServerPosition = server.positionAt(nowServerMs);

        clients.forEach((client) => {
            const finalDrift = Math.abs(client.localPosMs - finalServerPosition);
            if (client.label === 'bad') {
                expect(finalDrift).toBeLessThanOrEqual(150);
            } else {
                expect(finalDrift).toBeLessThanOrEqual(100);
            }
        });
    });
});
