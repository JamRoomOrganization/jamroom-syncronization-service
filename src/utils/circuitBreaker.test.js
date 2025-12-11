import { jest } from '@jest/globals';
import {
  CircuitBreaker,
  getCircuitBreaker,
  getAllCircuitBreakers,
  getAllCircuitMetrics,
  resetAllCircuitBreakers,
  clearCircuitBreakerRegistry,
  voiceServiceCircuit,
  queueServiceCircuit,
} from './circuitBreaker.js';

describe('CircuitBreaker – core behavior', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('inicializa en estado CLOSED con opciones por defecto', () => {
    const cb = new CircuitBreaker('test-cb');

    expect(cb.name).toBe('test-cb');
    expect(cb.state).toBe('CLOSED');
    expect(cb.failureCount).toBe(0);
    expect(cb.successCount).toBe(0);

    // Opciones default
    expect(cb.options.failureThreshold).toBe(5);
    expect(cb.options.successThreshold).toBe(2);
    expect(cb.options.timeout).toBe(30000);
    expect(cb.options.resetTimeout).toBe(60000);
  });

  it('execute ejecuta la función cuando el circuito está CLOSED y registra éxito', async () => {
    const cb = new CircuitBreaker('success-cb');
    const fn = jest.fn().mockResolvedValue('ok');

    const result = await cb.execute(fn);

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);

    const state = cb.getState();
    expect(state.state).toBe('CLOSED');
    expect(cb.metrics.totalCalls).toBe(1);
    expect(cb.metrics.successfulCalls).toBe(1);

    const metrics = cb.getMetrics();
    expect(metrics.totalCalls).toBe(1);
    expect(metrics.successRate).toBeCloseTo(100);
  });

  it('abre el circuito tras alcanzar el failureThreshold en estado CLOSED', async () => {
    const cb = new CircuitBreaker('fail-cb', { failureThreshold: 2 });
    const failingFn = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(cb.execute(failingFn)).rejects.toThrow('boom');
    await expect(cb.execute(failingFn)).rejects.toThrow('boom');

    expect(failingFn).toHaveBeenCalledTimes(2);

    const state = cb.getState();
    expect(state.state).toBe('OPEN');
    expect(state.failureCount).toBeGreaterThanOrEqual(2);
    expect(cb.metrics.failedCalls).toBe(2);
  });

  it('cuando está OPEN y no ha pasado el timeout, rechaza llamadas y usa fallback si existe', async () => {
    const cb = new CircuitBreaker('open-cb', {
      failureThreshold: 1,
      timeout: 30000,
      fallback: jest.fn().mockResolvedValue('fallback-value'),
    });

    const failingFn = jest.fn().mockRejectedValue(new Error('boom'));

    // Primera llamada → falla y abre el circuito
    await expect(cb.execute(failingFn)).rejects.toThrow('boom');
    expect(cb.getState().state).toBe('OPEN');

    const totalCallsBefore = cb.metrics.totalCalls;

    // Segunda llamada antes de timeout → no ejecuta fn, usa fallback
    const result = await cb.execute(() => Promise.resolve('should-not-run'));

    expect(result).toBe('fallback-value');
    expect(failingFn).toHaveBeenCalledTimes(1); // sólo la primera
    expect(cb.metrics.totalCalls).toBe(totalCallsBefore + 1);
    expect(cb.metrics.rejectedCalls).toBeGreaterThanOrEqual(1);
    expect(cb.metrics.fallbackCalls).toBe(1);
  });

  it('si el fallback falla, loggea error y lanza error CIRCUIT_BREAKER_OPEN', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const cb = new CircuitBreaker('open-cb-fallback-fail', {
      failureThreshold: 1,
      fallback: jest.fn().mockRejectedValue(new Error('fallback failed')),
    });

    const failingFn = jest.fn().mockRejectedValue(new Error('boom'));

    // Abrir circuito
    await expect(cb.execute(failingFn)).rejects.toThrow('boom');
    expect(cb.getState().state).toBe('OPEN');

    // Esta llamada irá a _handleRejection y el fallback también fallará
    await expect(cb.execute(() => Promise.resolve('x'))).rejects.toMatchObject({
      code: 'CIRCUIT_BREAKER_OPEN',
      circuitName: 'open-cb-fallback-fail',
    });

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('cuando está OPEN y no hay fallback, lanza error CIRCUIT_BREAKER_OPEN', async () => {
    const cb = new CircuitBreaker('open-no-fallback', {
      failureThreshold: 1,
      timeout: 30000,
    });

    const failingFn = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(cb.execute(failingFn)).rejects.toThrow('boom');
    expect(cb.getState().state).toBe('OPEN');

    await expect(cb.execute(() => Promise.resolve('x'))).rejects.toMatchObject({
      code: 'CIRCUIT_BREAKER_OPEN',
      circuitName: 'open-no-fallback',
    });
  });

  it('tras timeout pasa de OPEN a HALF_OPEN y con suficientes éxitos cierra de nuevo (CLOSED)', async () => {
    const baseTime = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTime);

    const cb = new CircuitBreaker('half-open-cb', {
      failureThreshold: 1,
      successThreshold: 2,
      timeout: 1000,
    });

    const failingFn = jest.fn().mockRejectedValue(new Error('boom'));

    // 1) Falla → OPEN
    await expect(cb.execute(failingFn)).rejects.toThrow('boom');
    expect(cb.getState().state).toBe('OPEN');

    // 2) Avanzamos el tiempo más allá del timeout → HALF_OPEN en próxima llamada
    nowSpy.mockReturnValue(baseTime + 1500);

    const successFn = jest.fn().mockResolvedValue('ok-1');
    const result1 = await cb.execute(successFn);

    expect(result1).toBe('ok-1');
    expect(cb.getState().state).toBe('HALF_OPEN');
    expect(cb.successCount).toBe(1);

    // 3) Segunda llamada exitosa → pasa a CLOSED
    nowSpy.mockReturnValue(baseTime + 2000);

    const result2 = await cb.execute(jest.fn().mockResolvedValue('ok-2'));

    expect(result2).toBe('ok-2');
    const state = cb.getState();
    expect(state.state).toBe('CLOSED');
    expect(state.failureCount).toBe(0);
    expect(state.successCount).toBe(0);

    nowSpy.mockRestore();
  });

  it('un fallo en HALF_OPEN reabre inmediatamente el circuito (OPEN)', async () => {
    const baseTime = 1_700_000_100_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTime);

    const cb = new CircuitBreaker('half-open-fail', {
      failureThreshold: 1,
      successThreshold: 2,
      timeout: 1000,
    });

    // Abrimos el circuito
    await expect(cb.execute(() => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(cb.getState().state).toBe('OPEN');

    // Pasado el timeout → HALF_OPEN
    nowSpy.mockReturnValue(baseTime + 1500);
    await cb
      .execute(() => Promise.resolve('first-success'))
      .catch(() => {});
    expect(cb.getState().state).toBe('HALF_OPEN');

    // Ahora un fallo en HALF_OPEN → vuelve a OPEN
    await expect(
      cb.execute(() => Promise.reject(new Error('fail-half-open'))),
    ).rejects.toThrow('fail-half-open');

    expect(cb.getState().state).toBe('OPEN');

    nowSpy.mockRestore();
  });

  it('reset pone el circuito en estado CLOSED y resetea contadores', async () => {
    const cb = new CircuitBreaker('reset-cb', { failureThreshold: 1 });

    await cb
      .execute(() => Promise.reject(new Error('boom')))
      .catch(() => {});

    expect(cb.getState().state).toBe('OPEN');
    expect(cb.failureCount).toBeGreaterThanOrEqual(1);

    cb.reset();

    const state = cb.getState();
    expect(state.state).toBe('CLOSED');
    expect(state.failureCount).toBe(0);
    expect(state.successCount).toBe(0);
    expect(state.lastFailureTime).toBeNull();
  });

  it('wrap devuelve una función que usa internamente execute', async () => {
    const cb = new CircuitBreaker('wrap-cb');
    const originalFn = jest.fn().mockResolvedValue('wrapped-ok');

    const wrapped = cb.wrap(originalFn);
    const result = await wrapped(1, 2, 3);

    expect(result).toBe('wrapped-ok');
    expect(originalFn).toHaveBeenCalledWith(1, 2, 3);
    expect(cb.metrics.totalCalls).toBe(1);
  });

  it('onStateChange que lanza error es atrapado y loggeado sin romper la transición', () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const cb = new CircuitBreaker('cb-on-state', {
      onStateChange: () => {
        throw new Error('listener error');
      },
    });

    // Forzamos transición directa usando el método interno
    cb._transitionTo('OPEN');

    expect(cb.getState().state).toBe('OPEN');
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});

describe('CircuitBreaker registry helpers', () => {
  beforeEach(() => {
    clearCircuitBreakerRegistry();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('getCircuitBreaker devuelve siempre la misma instancia por nombre', () => {
    const first = getCircuitBreaker('service-A', { failureThreshold: 1 });
    const second = getCircuitBreaker('service-A', { failureThreshold: 10 });

    expect(first).toBe(second);
    // Se mantienen las opciones de la primera creación
    expect(first.options.failureThreshold).toBe(1);
  });

  it('getAllCircuitBreakers devuelve el mapa de circuitos registrados', () => {
    const a = getCircuitBreaker('svc1');
    const b = getCircuitBreaker('svc2');

    const all = getAllCircuitBreakers();

    expect(all.size).toBe(2);
    expect(all.get('svc1')).toBe(a);
    expect(all.get('svc2')).toBe(b);
  });

  it('getAllCircuitMetrics devuelve métricas por nombre', async () => {
    const cb = getCircuitBreaker('metric-service');
    await cb.execute(() => Promise.resolve('ok'));

    const metrics = getAllCircuitMetrics();

    expect(metrics['metric-service']).toBeDefined();
    expect(metrics['metric-service'].totalCalls).toBe(1);
    expect(metrics['metric-service'].currentState).toBe('CLOSED');
  });

  it('resetAllCircuitBreakers resetea los circuitos pero mantiene el registro', async () => {
    const cb = getCircuitBreaker('reset-service', { failureThreshold: 1 });

    await cb
      .execute(() => Promise.reject(new Error('boom')))
      .catch(() => {});

    expect(cb.getState().state).toBe('OPEN');

    resetAllCircuitBreakers();

    expect(cb.getState().state).toBe('CLOSED');
    expect(getAllCircuitBreakers().size).toBe(1);
  });

  it('clearCircuitBreakerRegistry limpia completamente el registro', () => {
    getCircuitBreaker('a');
    getCircuitBreaker('b');

    expect(getAllCircuitBreakers().size).toBe(2);

    clearCircuitBreakerRegistry();

    expect(getAllCircuitBreakers().size).toBe(0);
  });
});

describe('Preconfigured circuits', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('voiceServiceCircuit y queueServiceCircuit son instancias configuradas de CircuitBreaker', () => {
    expect(voiceServiceCircuit).toBeInstanceOf(CircuitBreaker);
    expect(voiceServiceCircuit.name).toBe('voice-service');

    expect(queueServiceCircuit).toBeInstanceOf(CircuitBreaker);
    expect(queueServiceCircuit.name).toBe('queue-service');

    expect(voiceServiceCircuit.options.failureThreshold).toBe(5);
    expect(queueServiceCircuit.options.failureThreshold).toBe(5);
  });

  it('los onStateChange de los circuitos preconfigurados escriben logs al abrir/cerrar', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    // Forzamos OPEN en voiceServiceCircuit
    const cb = voiceServiceCircuit;
    cb.reset();

    const failingFn = jest.fn().mockRejectedValue(new Error('boom'));
    // failureThreshold = 5
    for (let i = 0; i < cb.options.failureThreshold; i++) {
      try {
        await cb.execute(failingFn);
      } catch (_) {
        // ignoramos
      }
    }

    expect(cb.getState().state).toBe('OPEN');
    expect(warnSpy).toHaveBeenCalled();

    // Forzamos transición a CLOSED llamando directamente al método interno
    cb._transitionTo('CLOSED');
    expect(logSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});
