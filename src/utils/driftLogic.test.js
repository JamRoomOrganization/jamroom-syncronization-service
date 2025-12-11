import { RATE_DURATION_MS, decideCorrection } from './driftLogic.js';

describe('decideCorrection', () => {
  it('devuelve ignore cuando los parámetros requeridos no son números válidos', () => {
    const result = decideCorrection({
      localPositionMs: NaN,
      observedServerPositionMs: 0,
      observedServerTimeMs: 0,
      nowServerMs: 0,
    });

    expect(result).toEqual({
      action: 'ignore',
      driftMs: null,
      serverExpectedNow: null,
      payload: null,
    });
  });

  it('devuelve ignore cuando el drift absoluto está por debajo del umbral ignore', () => {
    // thresholds base: ignore=60, rate=150, seek=300
    const result = decideCorrection({
      localPositionMs: 50, // drift 50ms
      observedServerPositionMs: 0,
      observedServerTimeMs: 0,
      nowServerMs: 0,
      jitterMs: 0,
      clientLagMs: 0,
    });

    expect(result.action).toBe('ignore');
    expect(result.driftMs).toBe(50);
    expect(result.payload).toBeNull();
  });

  it('devuelve acción rate cuando el drift está entre ignore y rate (con conexión normal)', () => {
    const result = decideCorrection({
      localPositionMs: 100, // drift 100ms
      observedServerPositionMs: 0,
      observedServerTimeMs: 0,
      nowServerMs: 0,
      jitterMs: 0,
      clientLagMs: 0,
    });

    expect(result.action).toBe('rate');
    expect(result.payload).not.toBeNull();
    expect(result.payload.durationMs).toBe(RATE_DURATION_MS);
    // playbackRate limitado entre 0.98 y 1.02
    expect(result.payload.playbackRate).toBeGreaterThanOrEqual(0.98);
    expect(result.payload.playbackRate).toBeLessThanOrEqual(1.02);
    expect(result.payload.reason).toContain('drift 100ms');
  });

  it('usa thresholds más agresivos y marca slow connection cuando jitter es alto', () => {
    // jitter>200 => slow connection, thresholds HIGH_JITTER: ignore=150, rate=300, seek=600
    const result = decideCorrection({
      localPositionMs: 200, // drift 200ms
      observedServerPositionMs: 0,
      observedServerTimeMs: 0,
      nowServerMs: 0,
      jitterMs: 300, // alto jitter
      clientLagMs: 0,
    });

    expect(result.action).toBe('rate');
    expect(result.payload).not.toBeNull();
    expect(result.payload.durationMs).toBeGreaterThan(RATE_DURATION_MS); // slow => duración extendida
    expect(result.payload.reason).toContain('[slow]');
  });

  it('para slow connections usa rate incluso cuando el drift está entre rate y seek', () => {
    // jitter>250 => HIGH_JITTER: ignore=150, rate=300, seek=600
    const result = decideCorrection({
      localPositionMs: 500, // drift 500ms -> entre 300 y 600
      observedServerPositionMs: 0,
      observedServerTimeMs: 0,
      nowServerMs: 0,
      jitterMs: 300,      // alto jitter
      clientLagMs: 500,   // lag alto => slow connection
    });

    expect(result.action).toBe('rate');
    expect(result.payload).not.toBeNull();
    expect(result.payload.reason).toContain('[slow]');
  });

  it('devuelve seek cuando el drift es grande y supera el umbral seek (conexión normal)', () => {
    // BASE_THRESHOLDS: seek=300
    const result = decideCorrection({
      localPositionMs: 400, // drift 400ms
      observedServerPositionMs: 0,
      observedServerTimeMs: 0,
      nowServerMs: 0,
      jitterMs: 0,
      clientLagMs: 0,
    });

    expect(result.action).toBe('seek');
    expect(result.payload).not.toBeNull();
    expect(result.payload.positionMs).toBe(0); // serverExpectedNow=0
    expect(result.payload.serverTimeMs).toBe(0);
    expect(result.payload.reason).toBeUndefined(); // conexión normal
  });

  it('devuelve seek con razón marcada como slow connection cuando la conexión es lenta', () => {
    // jitter muy alto => CRITICAL_JITTER_THRESHOLDS con seek grande,
    // pero ponemos un drift mucho más grande para forzar seek.
    const result = decideCorrection({
      localPositionMs: 2000, // gran drift
      observedServerPositionMs: 0,
      observedServerTimeMs: 0,
      nowServerMs: 0,
      jitterMs: 500,
      clientLagMs: 600,
    });

    expect(result.action).toBe('seek');
    expect(result.payload).not.toBeNull();
    expect(result.payload.positionMs).toBe(0);
    expect(result.payload.reason).toContain('[slow connection]');
  });

  it('corrige drift negativo ajustando el playbackRate hacia arriba', () => {
    // Cliente retrasado: drift negativo
    const result = decideCorrection({
      localPositionMs: -300, // drift -300ms
      observedServerPositionMs: 0,
      observedServerTimeMs: 0,
      nowServerMs: 0,
      jitterMs: 0,
      clientLagMs: 0,
    });

    expect(result.action).toBe('rate');
    const { playbackRate } = result.payload;
    // debería ser >1 y <= 1.02 por el clamp
    expect(playbackRate).toBeGreaterThan(1);
    expect(playbackRate).toBeLessThanOrEqual(1.02);
  });
});
