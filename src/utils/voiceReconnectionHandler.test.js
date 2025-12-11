import { jest } from '@jest/globals';

// =====================
// Mocks de dependencias
// =====================

const VoiceStateMock = {
  getParticipant: jest.fn(),
  joinVoice: jest.fn(),
  attachSession: jest.fn(),
  leaveVoice: jest.fn(),
  getVoiceState: jest.fn(),
};

const listVoiceSessionsByRoomMock = jest.fn();
const deleteVoiceSessionMock = jest.fn();
const createOrUpdateVoiceSessionMock = jest.fn();

const voiceServiceConfigMock = {
  isAvailable: true,
};

jest.unstable_mockModule('../voice/voiceState.js', () => ({
  VoiceState: VoiceStateMock,
}));

jest.unstable_mockModule('../services/voiceSessionsClient.js', () => ({
  listVoiceSessionsByRoom: listVoiceSessionsByRoomMock,
  deleteVoiceSession: deleteVoiceSessionMock,
  createOrUpdateVoiceSession: createOrUpdateVoiceSessionMock,
}));

jest.unstable_mockModule('../config/voiceServiceConfig.js', () => ({
  voiceServiceConfig: voiceServiceConfigMock,
}));

// Import del módulo bajo prueba (después de mockear dependencias)
const {
  markDisconnected,
  handleReconnection,
  reconcileRoomState,
  hasPendingReconnection,
  getPendingReconnectionCount,
  clearPendingReconnections,
  cleanupAllPending,
} = await import('./voiceReconnectionHandler.js');

describe('voiceReconnectionHandler - pending reconnections y utilidades', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    voiceServiceConfigMock.isAvailable = true;

    // Limpieza lógica de VoiceState
    VoiceStateMock.getParticipant.mockReset();
    VoiceStateMock.joinVoice.mockReset();
    VoiceStateMock.attachSession.mockReset();
    VoiceStateMock.leaveVoice.mockReset();
    VoiceStateMock.getVoiceState.mockReset();

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Ejecutar cualquier timer pendiente para no dejar basura
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    clearPendingReconnections();
  });

  // ---------------------------------------------------------------------------
  // markDisconnected + cleanup automático de sesión huérfana
  // ---------------------------------------------------------------------------
  it('markDisconnected registra pending y programa cleanup de sesión huérfana cuando hay sessionId', async () => {
    deleteVoiceSessionMock.mockResolvedValue(true);

    markDisconnected('room-1', 'user-1', {
      sessionId: 'sess-1',
      requestId: 'req-1',
    });

    expect(hasPendingReconnection('room-1', 'user-1')).toBe(true);
    expect(getPendingReconnectionCount()).toBe(1);

    // Debe haber al menos un timer programado
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    // Avanzar el tiempo hasta que se ejecute el cleanup (ORPHAN_CLEANUP_DELAY_MS = 5000)
    jest.advanceTimersByTime(5000);

    // Debe limpiar el estado local y llamar a deleteVoiceSession
    expect(VoiceStateMock.leaveVoice).toHaveBeenCalledWith('room-1', 'user-1');
    expect(deleteVoiceSessionMock).toHaveBeenCalledWith('sess-1', {
      requestId: 'req-1',
    });

    // Ya no debe haber pending para ese usuario
    expect(hasPendingReconnection('room-1', 'user-1')).toBe(false);
  });

  it('markDisconnected no programa cleanup cuando no hay sessionId', () => {
    markDisconnected('room-2', 'user-2');

    expect(hasPendingReconnection('room-2', 'user-2')).toBe(true);
    // No debería haber timers (no hay cleanupTimer)
    expect(jest.getTimerCount()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // hasPendingReconnection, getPendingReconnectionCount, clearPendingReconnections
  // ---------------------------------------------------------------------------
  it('clearPendingReconnections limpia todos los pending y cancela timers', () => {
    markDisconnected('room-3', 'user-3', { sessionId: 'sess-3' });
    markDisconnected('room-3', 'user-4');

    expect(getPendingReconnectionCount()).toBe(2);

    clearPendingReconnections();

    expect(getPendingReconnectionCount()).toBe(0);
    expect(hasPendingReconnection('room-3', 'user-3')).toBe(false);
    expect(hasPendingReconnection('room-3', 'user-4')).toBe(false);

    // No debería quedar ningún timer activo
    expect(jest.getTimerCount()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // cleanupAllPending
  // ---------------------------------------------------------------------------
  it('cleanupAllPending fuerza cleanup de todos los pending sin depender del timer', async () => {
    // Sin sessionId para evitar doble cleanup por timer
    markDisconnected('room-4', 'user-1');
    markDisconnected('room-4', 'user-2');

    expect(getPendingReconnectionCount()).toBe(2);

    await cleanupAllPending('req-cleanup');

    // Debe haber llamado leaveVoice para cada pending
    expect(VoiceStateMock.leaveVoice).toHaveBeenCalledTimes(2);
    expect(VoiceStateMock.leaveVoice).toHaveBeenCalledWith('room-4', 'user-1');
    expect(VoiceStateMock.leaveVoice).toHaveBeenCalledWith('room-4', 'user-2');

    // Mapa vacío
    expect(getPendingReconnectionCount()).toBe(0);
  });
});

describe('voiceReconnectionHandler - handleReconnection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    voiceServiceConfigMock.isAvailable = true;

    VoiceStateMock.getParticipant.mockReset();
    VoiceStateMock.joinVoice.mockReset();
    VoiceStateMock.attachSession.mockReset();
    VoiceStateMock.leaveVoice.mockReset();
    VoiceStateMock.getVoiceState.mockReset();

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    clearPendingReconnections();
  });

  it('retorna error cuando voiceServiceConfig.isAvailable=false y limpia el pending', async () => {
    voiceServiceConfigMock.isAvailable = false;

    markDisconnected('room-1', 'user-1');

    const res = await handleReconnection('room-1', 'user-1', {
      requestId: 'req-1',
    });

    expect(res).toEqual({
      recovered: false,
      error: 'voice_service_unavailable',
    });

    // Debe haberse eliminado de pending
    expect(hasPendingReconnection('room-1', 'user-1')).toBe(false);
    expect(listVoiceSessionsByRoomMock).not.toHaveBeenCalled();
  });

  it('recupera la sesión cuando existe en el servicio y no está en VoiceState local', async () => {
    voiceServiceConfigMock.isAvailable = true;

    markDisconnected('room-2', 'user-2', { sessionId: 'sess-2' });

    listVoiceSessionsByRoomMock.mockResolvedValue([
      {
        userId: 'user-2',
        sessionId: 'sess-2',
        role: 'speaker',
        canPublishAudio: true,
      },
    ]);

    VoiceStateMock.getParticipant.mockReturnValue(null);

    const res = await handleReconnection('room-2', 'user-2', {
      requestId: 'req-2',
    });

    expect(listVoiceSessionsByRoomMock).toHaveBeenCalledWith('room-2', {
      requestId: 'req-2',
      noRetry: true,
    });

    expect(VoiceStateMock.joinVoice).toHaveBeenCalledWith('room-2', 'user-2', {
      role: 'speaker',
      canPublishAudio: true,
    });
    expect(VoiceStateMock.attachSession).toHaveBeenCalledWith(
      'room-2',
      'user-2',
      'sess-2',
    );

    expect(res.recovered).toBe(true);
    expect(res.session).toEqual(
      expect.objectContaining({
        userId: 'user-2',
        sessionId: 'sess-2',
      }),
    );

    // Pending debe desaparecer
    expect(hasPendingReconnection('room-2', 'user-2')).toBe(false);
  });

  it('no re-joinea en VoiceState si ya estaba en local, pero marca recovered=true', async () => {
    markDisconnected('room-3', 'user-3', { sessionId: 'sess-3' });

    listVoiceSessionsByRoomMock.mockResolvedValue([
      {
        userId: 'user-3',
        sessionId: 'sess-3',
        role: 'host',
        canPublishAudio: true,
      },
    ]);

    VoiceStateMock.getParticipant.mockReturnValue({ userId: 'user-3' });

    const res = await handleReconnection('room-3', 'user-3', {
      requestId: 'req-3',
    });

    expect(VoiceStateMock.joinVoice).not.toHaveBeenCalled();
    expect(VoiceStateMock.attachSession).not.toHaveBeenCalled();

    expect(res.recovered).toBe(true);
    expect(res.session.userId).toBe('user-3');
  });

  it('limpia estado local cuando no hay sesión remota pero sí participante local', async () => {
    markDisconnected('room-4', 'user-4');

    listVoiceSessionsByRoomMock.mockResolvedValue([]); // no remote sessions
    VoiceStateMock.getParticipant.mockReturnValue({ userId: 'user-4' });

    const res = await handleReconnection('room-4', 'user-4', {
      requestId: 'req-4',
    });

    expect(VoiceStateMock.leaveVoice).toHaveBeenCalledWith('room-4', 'user-4');
    expect(res).toEqual({ recovered: false });
  });

  it('no hace nada especial cuando no hay sesión remota ni participante local', async () => {
    markDisconnected('room-5', 'user-5');

    listVoiceSessionsByRoomMock.mockResolvedValue([]);
    VoiceStateMock.getParticipant.mockReturnValue(null);

    const res = await handleReconnection('room-5', 'user-5', {
      requestId: 'req-5',
    });

    expect(VoiceStateMock.leaveVoice).not.toHaveBeenCalled();
    expect(res).toEqual({ recovered: false });
  });

  it('retorna error cuando falla la reconciliación con el servicio', async () => {
    listVoiceSessionsByRoomMock.mockRejectedValue(new Error('boom'));

    markDisconnected('room-6', 'user-6');

    const res = await handleReconnection('room-6', 'user-6', {
      requestId: 'req-6',
    });

    expect(console.error).toHaveBeenCalled();
    expect(res.recovered).toBe(false);
    expect(res.error).toBe('boom');
  });
});

describe('voiceReconnectionHandler - reconcileRoomState', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    voiceServiceConfigMock.isAvailable = true;

    VoiceStateMock.getParticipant.mockReset();
    VoiceStateMock.joinVoice.mockReset();
    VoiceStateMock.attachSession.mockReset();
    VoiceStateMock.leaveVoice.mockReset();
    VoiceStateMock.getVoiceState.mockReset();

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    clearPendingReconnections();
  });

  it('cuando el servicio no está disponible, sólo devuelve {added:[], removed:[]} y loggea warning', async () => {
    voiceServiceConfigMock.isAvailable = false;

    const res = await reconcileRoomState('room-1', { requestId: 'req-state-1' });

    expect(res).toEqual({ added: [], removed: [] });
    expect(console.warn).toHaveBeenCalled();
    expect(listVoiceSessionsByRoomMock).not.toHaveBeenCalled();
  });

  it('reconcilia: agrega usuarios remotos faltantes y remueve locales huérfanos', async () => {
    voiceServiceConfigMock.isAvailable = true;

    // Remotos: userA y userB
    listVoiceSessionsByRoomMock.mockResolvedValue([
      {
        userId: 'userA',
        sessionId: 'sess-A',
        role: 'speaker',
        canPublishAudio: true,
      },
      {
        userId: 'userB',
        sessionId: 'sess-B',
        role: 'listener',
        canPublishAudio: false,
      },
    ]);

    // Local: userB y userC
    VoiceStateMock.getVoiceState.mockReturnValue({
      roomId: 'room-2',
      participants: [
        { userId: 'userB' },
        { userId: 'userC' },
      ],
    });

    const res = await reconcileRoomState('room-2', { requestId: 'req-state-2' });

    // userA: remoto y no local -> se agrega
    expect(VoiceStateMock.joinVoice).toHaveBeenCalledWith('room-2', 'userA', {
      role: 'speaker',
      canPublishAudio: true,
    });
    expect(VoiceStateMock.attachSession).toHaveBeenCalledWith(
      'room-2',
      'userA',
      'sess-A',
    );

    // userC: local y no remoto -> se elimina
    expect(VoiceStateMock.leaveVoice).toHaveBeenCalledWith('room-2', 'userC');

    expect(res.added).toEqual(['userA']);
    expect(res.removed).toEqual(['userC']);

    // Debe loggear reconciliación si hubo cambios
    expect(console.log).toHaveBeenCalled();
  });

  it('si listVoiceSessionsByRoom lanza error, loggea y devuelve sin cambios', async () => {
    listVoiceSessionsByRoomMock.mockRejectedValue(new Error('service down'));

    const res = await reconcileRoomState('room-3', { requestId: 'req-state-3' });

    expect(res).toEqual({ added: [], removed: [] });
    expect(console.error).toHaveBeenCalled();
    expect(VoiceStateMock.joinVoice).not.toHaveBeenCalled();
    expect(VoiceStateMock.leaveVoice).not.toHaveBeenCalled();
  });
});
