import { jest } from '@jest/globals';

import {
  recordJitterSample,
  recordRttSample,
  getClientNetworkState,
  getConnectionQuality,
  getEstimatedJitter,
  getEstimatedRtt,
  removeClient,
  getAdaptiveSyncParameters,
  getRecommendedPrebuffer,
  getNetworkMetrics,
  cleanupStaleClients,
  clearAllClientStates,
} from './jitterBuffer.js';

describe('jitterBuffer', () => {
  beforeEach(() => {
    clearAllClientStates();
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // recordJitterSample / recordRttSample / getClientNetworkState
  // ---------------------------------------------------------------------------

  it('recordJitterSample ignora valores inválidos y no crea estado', () => {
    recordJitterSample('c1', NaN);
    recordJitterSample('c1', -10);

    const state = getClientNetworkState('c1');
    expect(state).toBeNull();
  });

  it('recordRttSample ignora valores inválidos y no crea estado', () => {
    recordRttSample('c1', NaN);
    recordRttSample('c1', -5);

    const state = getClientNetworkState('c1');
    expect(state).toBeNull();
  });

  it('recordJitterSample crea estado, acumula samples y aplica EMA', () => {
    const clientId = 'client-jitter';

    // Primer sample: EMA debe ser igual al valor
    recordJitterSample(clientId, 100);
    let state = getClientNetworkState(clientId);

    expect(state).not.toBeNull();
    expect(state.jitterSamples).toEqual([100]);
    expect(state.sampleCount).toBe(1);
    expect(state.emaJitter).toBeCloseTo(100);

    // Segundo sample: EMA = alpha * nuevo + (1-alpha) * viejo
    // alpha = 0.3 → ema = 0.3*50 + 0.7*100 = 15 + 70 = 85
    recordJitterSample(clientId, 50);
    state = getClientNetworkState(clientId);

    expect(state.jitterSamples).toEqual([100, 50]);
    expect(state.sampleCount).toBe(2);
    expect(state.emaJitter).toBeCloseTo(85, 1);
  });

  it('recordJitterSample y recordRttSample limitan samples a MAX_SAMPLES', () => {
    const clientId = 'client-max';

    // Empuja más de 50 samples de jitter
    for (let i = 0; i < 60; i++) {
      recordJitterSample(clientId, 10 + i);
    }

    // Empuja más de 50 samples de RTT
    for (let i = 0; i < 60; i++) {
      recordRttSample(clientId, 20 + i);
    }

    const state = getClientNetworkState(clientId);
    expect(state.jitterSamples.length).toBeLessThanOrEqual(50);
    expect(state.rttSamples.length).toBeLessThanOrEqual(50);
  });

  it('recordRttSample crea estado y actualiza EMA de RTT', () => {
    const clientId = 'client-rtt';

    recordRttSample(clientId, 150); // primer sample
    let state = getClientNetworkState(clientId);

    expect(state).not.toBeNull();
    expect(state.rttSamples).toEqual([150]);
    expect(state.emaRtt).toBeCloseTo(150);

    // segundo sample → ema = 0.3*100 + 0.7*150 = 135
    recordRttSample(clientId, 100);
    state = getClientNetworkState(clientId);

    expect(state.rttSamples).toEqual([150, 100]);
    expect(state.emaRtt).toBeCloseTo(135, 1);
  });

  // ---------------------------------------------------------------------------
  // getConnectionQuality / getEstimatedJitter / getEstimatedRtt
  // ---------------------------------------------------------------------------

  it('getClientNetworkState devuelve null si no existe el cliente', () => {
    expect(getClientNetworkState('unknown')).toBeNull();
  });

  it('getConnectionQuality devuelve "good" si no hay estado', () => {
    expect(getConnectionQuality('no-state')).toBe('good');
  });

  it('clasifica la calidad como excellent / good / fair / poor / critical según jitter y RTT', () => {
    const clientId = 'client-quality';

    // Excellent: jitter y RTT muy bajos
    for (let i = 0; i < 3; i++) {
      recordJitterSample(clientId, 20, 50); // ambos dentro de "excellent"
    }
    expect(getConnectionQuality(clientId)).toBe('excellent');

    clearAllClientStates();

    // Good: jitter/RTT dentro de "good"
    for (let i = 0; i < 3; i++) {
      recordJitterSample(clientId, 40, 150);
    }
    expect(getConnectionQuality(clientId)).toBe('good');

    clearAllClientStates();

    // Fair
    for (let i = 0; i < 3; i++) {
      recordJitterSample(clientId, 80, 300);
    }
    expect(getConnectionQuality(clientId)).toBe('fair');

    clearAllClientStates();

    // Poor
    for (let i = 0; i < 3; i++) {
      recordJitterSample(clientId, 200, 700);
    }
    expect(getConnectionQuality(clientId)).toBe('poor');

    clearAllClientStates();

    // Critical (por jitter y RTT muy altos)
    for (let i = 0; i < 3; i++) {
      recordJitterSample(clientId, 400, 1000);
    }
    expect(getConnectionQuality(clientId)).toBe('critical');
  });

  it('getEstimatedJitter devuelve 0 si no hay suficientes samples y el EMA redondeado si sí', () => {
    const clientId = 'client-jitter-est';

    // Menos de 3 muestras → 0
    recordJitterSample(clientId, 100);
    expect(getEstimatedJitter(clientId)).toBe(0);

    recordJitterSample(clientId, 80);
    expect(getEstimatedJitter(clientId)).toBe(0);

    // Tercera muestra → ya debe usar EMA
    recordJitterSample(clientId, 60);
    const est = getEstimatedJitter(clientId);

    expect(est).toBeGreaterThan(0);
    // No validamos el número exacto, pero que sea razonable
    expect(typeof est).toBe('number');
  });

  it('getEstimatedRtt devuelve 0 si no hay suficientes samples y el EMA redondeado si sí', () => {
    const clientId = 'client-rtt-est';

    // Menos de 3 muestras → 0
    recordRttSample(clientId, 200);
    expect(getEstimatedRtt(clientId)).toBe(0);

    recordRttSample(clientId, 180);
    expect(getEstimatedRtt(clientId)).toBe(0);

    // Tercera muestra → ya debe usar EMA
    recordRttSample(clientId, 160);
    const est = getEstimatedRtt(clientId);

    expect(est).toBeGreaterThan(0);
    expect(typeof est).toBe('number');
  });

  it('removeClient borra el estado del cliente', () => {
    const clientId = 'client-remove';

    recordJitterSample(clientId, 50, 100);
    expect(getClientNetworkState(clientId)).not.toBeNull();

    removeClient(clientId);
    expect(getClientNetworkState(clientId)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // getAdaptiveSyncParameters
  // ---------------------------------------------------------------------------

  it('getAdaptiveSyncParameters devuelve parámetros base para conexiones good', () => {
    const clientId = 'client-good';

    // Forzamos calidad good
    for (let i = 0; i < 3; i++) {
      recordJitterSample(clientId, 40, 150);
    }

    const params = getAdaptiveSyncParameters(clientId);

    expect(params).toEqual({
      ignoreThresholdMs: 60,
      rateThresholdMs: 150,
      seekThresholdMs: 300,
      syncIntervalMs: 1000,
      useAggressiveSeek: false,
    });
  });

  it('getAdaptiveSyncParameters ajusta parámetros para fair / poor / critical', () => {
    const clientId = 'client-fair';

    // fair
    for (let i = 0; i < 3; i++) {
      recordJitterSample(clientId, 80, 300);
    }
    const fairParams = getAdaptiveSyncParameters(clientId);
    expect(fairParams.ignoreThresholdMs).toBe(100);
    expect(fairParams.syncIntervalMs).toBe(1500);

    clearAllClientStates();

    // poor
    for (let i = 0; i < 3; i++) {
      recordJitterSample(clientId, 200, 700);
    }
    const poorParams = getAdaptiveSyncParameters(clientId);
    expect(poorParams.ignoreThresholdMs).toBe(150);
    expect(poorParams.syncIntervalMs).toBe(2000);
    expect(poorParams.useAggressiveSeek).toBe(false);

    clearAllClientStates();

    // critical
    for (let i = 0; i < 3; i++) {
      recordJitterSample(clientId, 400, 1000);
    }
    const criticalParams = getAdaptiveSyncParameters(clientId);
    expect(criticalParams.ignoreThresholdMs).toBe(200);
    expect(criticalParams.syncIntervalMs).toBe(3000);
    expect(criticalParams.useAggressiveSeek).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // getRecommendedPrebuffer
  // ---------------------------------------------------------------------------

  it('getRecommendedPrebuffer calcula el prebuffer en función de calidad, jitter y rtt', () => {
    const clientId = 'client-prebuffer';

    // Simula una conexión fair
    for (let i = 0; i < 3; i++) {
      recordJitterSample(clientId, 100, 300);
    }

    const prebuffer = getRecommendedPrebuffer(clientId);

    expect(typeof prebuffer).toBe('number');
    expect(prebuffer).toBeGreaterThanOrEqual(500);
    expect(prebuffer).toBeLessThanOrEqual(10000);
  });

  it('getRecommendedPrebuffer respeta los límites [500ms, 10000ms]', () => {
    const clientLow = 'client-low';
    const clientHigh = 'client-high';

    // Calidad excellent, jitter y rtt muy bajos → debería aproximarse al mínimo
    for (let i = 0; i < 3; i++) {
      recordJitterSample(clientLow, 5, 10);
    }
    const lowPrebuffer = getRecommendedPrebuffer(clientLow);
    expect(lowPrebuffer).toBeGreaterThanOrEqual(500);

    clearAllClientStates();

    // Calidad critical, jitter y rtt muy altos → debe estar topeado en 10000
    for (let i = 0; i < 3; i++) {
      recordJitterSample(clientHigh, 1000, 2000);
    }
    const highPrebuffer = getRecommendedPrebuffer(clientHigh);
    expect(highPrebuffer).toBeLessThanOrEqual(10000);
  });

  // ---------------------------------------------------------------------------
  // getNetworkMetrics
  // ---------------------------------------------------------------------------

  it('getNetworkMetrics devuelve métricas agregadas coherentes', () => {
    clearAllClientStates();

    // Cliente 1: good
    for (let i = 0; i < 3; i++) {
      recordJitterSample('c1', 40, 150);
    }

    // Cliente 2: poor
    for (let i = 0; i < 3; i++) {
      recordJitterSample('c2', 220, 700);
    }

    const metrics = getNetworkMetrics();

    expect(metrics.totalClients).toBe(2);
    expect(metrics.byQuality.good + metrics.byQuality.poor).toBe(2);
    expect(metrics.avgJitter).toBeGreaterThan(0);
    expect(metrics.avgRtt).toBeGreaterThan(0);
    expect(metrics.maxJitter).toBeGreaterThanOrEqual(metrics.avgJitter);
    expect(metrics.maxRtt).toBeGreaterThanOrEqual(metrics.avgRtt);
  });

  // ---------------------------------------------------------------------------
  // cleanupStaleClients / clearAllClientStates
  // ---------------------------------------------------------------------------

  it('cleanupStaleClients elimina estados más antiguos que maxAgeMs', () => {
    clearAllClientStates();

    const baseTime = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTime);

    // Cliente "viejo"
    recordJitterSample('old', 50, 100);

    // Avanzamos el tiempo más allá de maxAge
    nowSpy.mockReturnValue(baseTime + 400_000); // 400s

    const removed = cleanupStaleClients(300_000); // 300s
    expect(removed).toBe(1);
    expect(getClientNetworkState('old')).toBeNull();

    nowSpy.mockRestore();
  });

  it('clearAllClientStates limpia todos los estados', () => {
    recordJitterSample('c1', 50, 100);
    recordJitterSample('c2', 80, 200);

    expect(getNetworkMetrics().totalClients).toBe(2);

    clearAllClientStates();
    expect(getNetworkMetrics().totalClients).toBe(0);
  });
});
