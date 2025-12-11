import {
  validatePlayBody,
  validatePauseBody,
  validateSeekBody,
  validateTrackBody,
} from './validators.js';

describe('validators - play/track common logic', () => {
  it('validatePlayBody devuelve ok=true con datos normalizados cuando el body es válido', () => {
    const result = validatePlayBody({
      userId: '  user-1  ',
      trackId: '  track-xyz  ',
      startPositionMs: 1500,
      playbackRate: 1.25,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      userId: 'user-1',
      trackId: 'track-xyz',
      startPositionMs: 1500,
      playbackRate: 1.25,
    });
  });

  it('validatePlayBody usa startPositionMs = 0 por defecto cuando no viene en el body', () => {
    const result = validatePlayBody({
      userId: 'user-1',
      trackId: 'track-1',
      // sin startPositionMs
      playbackRate: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.data.startPositionMs).toBe(0);
  });

  it('validatePlayBody devuelve error cuando falta userId o es string vacío', () => {
    const result = validatePlayBody({
      userId: '   ', // inválido
      trackId: 'track-1',
      startPositionMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toEqual({
      field: 'userId',
      reason: 'required',
    });
  });

  it('validatePlayBody devuelve error cuando falta trackId o es vacío', () => {
    const result = validatePlayBody({
      userId: 'user-1',
      trackId: '   ', // inválido
      startPositionMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toEqual({
      field: 'trackId',
      reason: 'required',
    });
  });

  it('validatePlayBody devuelve error cuando startPositionMs es inválido', () => {
    const result = validatePlayBody({
      userId: 'user-1',
      trackId: 'track-1',
      startPositionMs: -10, // no negativo
    });

    expect(result.ok).toBe(false);
    expect(result.error).toEqual({
      field: 'startPositionMs',
      reason: 'invalid',
    });
  });

  it('validatePlayBody asigna playbackRate=1 por defecto cuando no viene en el body', () => {
    const result = validatePlayBody({
      userId: 'user-1',
      trackId: 'track-1',
      startPositionMs: 0,
    });

    expect(result.ok).toBe(true);
    expect(result.data.playbackRate).toBe(1);
  });

  it('validatePlayBody devuelve error cuando playbackRate es inválido (no número, NaN o <= 0)', () => {
    const invalidRates = [0, -1, NaN, Infinity, '1.0'];

    for (const rate of invalidRates) {
      const result = validatePlayBody({
        userId: 'user-1',
        trackId: 'track-1',
        startPositionMs: 0,
        playbackRate: rate,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toEqual({
        field: 'playbackRate',
        reason: 'invalid',
      });
    }
  });
});

describe('validators - pause', () => {
  it('validatePauseBody devuelve ok=true y userId trimmeado cuando es válido', () => {
    const result = validatePauseBody({
      userId: '  user-1  ',
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      userId: 'user-1',
    });
  });

  it('validatePauseBody devuelve error cuando userId es inválido', () => {
    const result = validatePauseBody({
      userId: '   ',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toEqual({
      field: 'userId',
      reason: 'required',
    });
  });
});

describe('validators - seek', () => {
  it('validateSeekBody devuelve ok=true con datos cuando body es válido', () => {
    const result = validateSeekBody({
      userId: '  user-2 ',
      positionMs: 3000,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      userId: 'user-2',
      positionMs: 3000,
    });
  });

  it('validateSeekBody devuelve error cuando userId es inválido', () => {
    const result = validateSeekBody({
      userId: '',
      positionMs: 1000,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toEqual({
      field: 'userId',
      reason: 'required',
    });
  });

  it('validateSeekBody devuelve error cuando positionMs es inválido', () => {
    const result = validateSeekBody({
      userId: 'user-1',
      positionMs: -5,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toEqual({
      field: 'positionMs',
      reason: 'invalid',
    });
  });
});

describe('validators - track (alias de play)', () => {
  it('validateTrackBody delega en lógica común y devuelve ok=true cuando es válido', () => {
    const result = validateTrackBody({
      userId: 'user-x',
      trackId: 'track-x',
      startPositionMs: 42,
      playbackRate: 1.1,
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      userId: 'user-x',
      trackId: 'track-x',
      startPositionMs: 42,
      playbackRate: 1.1,
    });
  });
});
