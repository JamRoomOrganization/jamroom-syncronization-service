import { jest } from '@jest/globals';
import {
  emitVoiceStateThrottled,
  cleanupRoomThrottle,
  getThrottleMetrics,
  resetThrottleMetrics,
  clearAllThrottleState,
  getAdaptiveThrottle,
  clearAdaptiveThrottle,
} from './voiceStateThrottle.js';

describe('voiceStateThrottle - throttling de voice:state', () => {
  let io;
  let emitMock;
  let toMock;

  beforeEach(() => {
    // Mock de Socket.IO
    emitMock = jest.fn();
    toMock = jest.fn().mockReturnValue({ emit: emitMock });
    io = { to: toMock };

    // Limpiar estado global entre pruebas
    resetThrottleMetrics();
    clearAllThrottleState();
  });

  // ---------------------------------------------------------------------------
  // Emisión inmediata
  // ---------------------------------------------------------------------------
  it('emite inmediatamente cuando immediate=true y actualiza métricas', () => {
    const state = { participants: [] };

    emitVoiceStateThrottled(io, 'room-1', state, { immediate: true });

    expect(toMock).toHaveBeenCalledWith('room:room-1');
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith('voice:state', state);

    const metrics = getThrottleMetrics();
    expect(metrics.totalEmits).toBe(1);
    expect(metrics.immediateEmits).toBe(1);
    expect(metrics.throttledEmits).toBe(0);
    expect(metrics.coalescedUpdates).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Throttling + coalescing
  // ---------------------------------------------------------------------------
  it('aplica throttling: coalesce actualizaciones y emite luego del intervalo', async () => {
    const firstState = { participants: ['user-1'] };
    const secondState = { participants: ['user-1', 'user-2'] };

    // Primer llamada: como lastEmitTime inicial es 0 y Date.now es "grande",
    // la primera emisión suele ser inmediata.
    emitVoiceStateThrottled(io, 'room-1', firstState, { throttleMs: 50 });

    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenLastCalledWith('voice:state', firstState);

    // Segunda llamada casi inmediatamente: debe quedar coalescida y NO emitirse aún.
    emitVoiceStateThrottled(io, 'room-1', secondState, { throttleMs: 50 });

    // Sigue habiendo sólo 1 emisión antes del timeout
    expect(emitMock).toHaveBeenCalledTimes(1);

    // Esperamos un poco más que el throttle mínimo (50 ms) para que dispare el setTimeout
    await new Promise((resolve) => setTimeout(resolve, 70));

    // Ahora debe haberse emitido el estado coalescido (secondState)
    expect(emitMock).toHaveBeenCalledTimes(2);
    expect(emitMock).toHaveBeenLastCalledWith('voice:state', secondState);

    const metrics = getThrottleMetrics();
    expect(metrics.totalEmits).toBeGreaterThanOrEqual(2);
    expect(metrics.throttledEmits).toBeGreaterThanOrEqual(1);
    expect(metrics.coalescedUpdates).toBeGreaterThanOrEqual(1);
    expect(metrics.activeRooms).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // cleanupRoomThrottle
  // ---------------------------------------------------------------------------
  it('cleanupRoomThrottle limpia el timer pendiente y evita la emisión posterior', async () => {
    const state1 = { participants: ['user-1'] };
    const state2 = { participants: ['user-1', 'user-2'] };

    // Primera emisión (normal)
    emitVoiceStateThrottled(io, 'room-2', state1, { throttleMs: 50 });
    expect(emitMock).toHaveBeenCalledTimes(1);

    // Segunda actualización: se coalesce y programa un timer
    emitVoiceStateThrottled(io, 'room-2', state2, { throttleMs: 50 });
    // Aún sólo 1 emisión
    expect(emitMock).toHaveBeenCalledTimes(1);

    // Limpiamos el throttle de esa sala ANTES de que dispare el timer
    cleanupRoomThrottle('room-2');

    // Esperamos más que el throttle para asegurarnos de que si el timer siguiera activo, se vería
    await new Promise((resolve) => setTimeout(resolve, 70));

    // No debe haberse producido una segunda emisión
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Métricas y reseteo
  // ---------------------------------------------------------------------------
  it('getThrottleMetrics refleja métricas y resetThrottleMetrics las reinicia', async () => {
    const state = { participants: ['user-1'] };

    // Generar alguna actividad
    emitVoiceStateThrottled(io, 'room-3', state, { throttleMs: 50 });
    emitVoiceStateThrottled(io, 'room-3', { participants: ['user-1', 'user-2'] }, { throttleMs: 50 });

    await new Promise((resolve) => setTimeout(resolve, 70));

    const metricsBefore = getThrottleMetrics();
    expect(metricsBefore.totalEmits).toBeGreaterThan(0);
    expect(metricsBefore.throttleRate).toEqual(
      expect.stringMatching(/^\d+(\.\d+)?%$/),
    );

    // Limpiamos métricas y estado
    resetThrottleMetrics();
    clearAllThrottleState();

    const metricsAfter = getThrottleMetrics();
    expect(metricsAfter.totalEmits).toBe(0);
    expect(metricsAfter.throttledEmits).toBe(0);
    expect(metricsAfter.immediateEmits).toBe(0);
    expect(metricsAfter.coalescedUpdates).toBe(0);
    expect(metricsAfter.activeRooms).toBe(0);
    expect(metricsAfter.throttleRate).toBe('0%');
    expect(metricsAfter.avgCoalescedPerThrottle).toBe(0);
  });

  it('clearAllThrottleState elimina el estado de todas las salas', async () => {
    const state = { participants: [] };

    emitVoiceStateThrottled(io, 'room-A', state, { throttleMs: 50 });
    emitVoiceStateThrottled(io, 'room-B', state, { throttleMs: 50 });

    await new Promise((resolve) => setTimeout(resolve, 70));

    const metricsBefore = getThrottleMetrics();
    expect(metricsBefore.activeRooms).toBeGreaterThanOrEqual(1);

    clearAllThrottleState();

    const metricsAfter = getThrottleMetrics();
    expect(metricsAfter.activeRooms).toBe(0);
  });
});

describe('voiceStateThrottle - adaptive throttle', () => {
  beforeEach(() => {
    // No hace falta tocar timers aquí, sólo limpiar métricas/estado básico
    resetThrottleMetrics();
  });

  // ---------------------------------------------------------------------------
  // getAdaptiveThrottle básico
  // ---------------------------------------------------------------------------
  it('getAdaptiveThrottle usa minThrottleMs en la primera llamada y mantiene estado por sala', () => {
    const config = {
      minThrottleMs: 50,
      maxThrottleMs: 500,
      targetUpdatesPerSecond: 5,
    };

    const t1 = getAdaptiveThrottle('adaptive-room-1', config);
    expect(t1).toBe(50);

    const t2 = getAdaptiveThrottle('adaptive-room-2', config);
    expect(t2).toBe(50);

    // Segunda llamada en la misma sala ya puede ajustar, pero sigue siendo >= minThrottleMs
    const t1b = getAdaptiveThrottle('adaptive-room-1', config);
    expect(t1b).toBeGreaterThanOrEqual(50);
  });

  // ---------------------------------------------------------------------------
  // Aumenta el throttle cuando la tasa de updates es alta y luego lo reduce
  // ---------------------------------------------------------------------------
  it('aumenta el throttle con actividad alta y luego lo reduce cuando baja la actividad', async () => {
    const config = {
      minThrottleMs: 50,
      maxThrottleMs: 500,
      targetUpdatesPerSecond: 5,
    };

    let throttle = getAdaptiveThrottle('adaptive-room-3', config);
    expect(throttle).toBe(50); // inicio en mínimo

    // Simulamos alta actividad (muchas llamadas en < 1s)
    for (let i = 0; i < 15; i++) {
      throttle = getAdaptiveThrottle('adaptive-room-3', config);
    }

    const increasedThrottle = throttle;
    expect(increasedThrottle).toBeGreaterThan(50);

    // Esperamos > 1 segundo para que la ventana de "recentUpdates" se vacíe
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const decreasedThrottle = getAdaptiveThrottle('adaptive-room-3', config);
    expect(decreasedThrottle).toBeLessThanOrEqual(increasedThrottle);
    expect(decreasedThrottle).toBeGreaterThanOrEqual(50);
  });

  // ---------------------------------------------------------------------------
  // clearAdaptiveThrottle
  // ---------------------------------------------------------------------------
  it('clearAdaptiveThrottle reinicia el estado adaptativo de una sala', async () => {
    const config = {
      minThrottleMs: 50,
      maxThrottleMs: 500,
      targetUpdatesPerSecond: 5,
    };

    // Forzamos un throttle mayor al mínimo
    let throttle = 0;
    for (let i = 0; i < 15; i++) {
      throttle = getAdaptiveThrottle('adaptive-room-4', config);
    }
    expect(throttle).toBeGreaterThan(50);

    // Borramos el estado adaptativo
    clearAdaptiveThrottle('adaptive-room-4');

    // La siguiente llamada debería comportarse como "primera" -> minThrottleMs
    const resetThrottle = getAdaptiveThrottle('adaptive-room-4', config);
    expect(resetThrottle).toBe(50);
  });
});
