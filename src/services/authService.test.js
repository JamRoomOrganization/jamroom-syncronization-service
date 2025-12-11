import { jest } from '@jest/globals';

// Mocks
const RedisServiceMock = {
  getRoomHost: jest.fn(),
  setRoomHostIfEmpty: jest.fn(),
  clearRoomHost: jest.fn(),
};

const queueMembershipClientMock = {
  getMyMembership: jest.fn(),
};

const isSafeIdMock = jest.fn();

// Mock de módulos ESM
jest.unstable_mockModule('./redisService.js', () => ({
  RedisService: RedisServiceMock,
}));

jest.unstable_mockModule('./queueMembershipClient.js', () => ({
  queueMembershipClient: queueMembershipClientMock,
}));

jest.unstable_mockModule('../utils/idValidator.js', () => ({
  isSafeId: isSafeIdMock,
}));

const { AuthService } = await import('./authService.js');

describe('AuthService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    isSafeIdMock.mockReturnValue(true);
  });

  // ---------------------------------------------------------------------------
  // canControlRoom
  // ---------------------------------------------------------------------------
  describe('canControlRoom', () => {
    it('devuelve false cuando userId o roomId no son seguros', async () => {
      isSafeIdMock.mockReturnValue(false);

      const result = await AuthService.canControlRoom('userX', 'roomX');

      expect(result).toBe(false);
      expect(RedisServiceMock.getRoomHost).not.toHaveBeenCalled();
    });

    it('si no hay host, intenta fijar el host en Redis y si sigue vacío deja controlar al usuario', async () => {
      // Primera consulta: no hay host
      RedisServiceMock.getRoomHost.mockResolvedValueOnce(null);
      // Después de setRoomHostIfEmpty, sigue sin host
      RedisServiceMock.getRoomHost.mockResolvedValueOnce(null);

      const result = await AuthService.canControlRoom('user-1', 'room-no-host');

      expect(RedisServiceMock.getRoomHost).toHaveBeenCalledTimes(2);
      expect(RedisServiceMock.setRoomHostIfEmpty).toHaveBeenCalledWith(
        'room-no-host',
        'user-1',
      );
      expect(result).toBe(true);
    });

    it('devuelve true cuando el host coincide con el userId', async () => {
      // Usamos un roomId único para evitar efectos del caché
      RedisServiceMock.getRoomHost.mockResolvedValue('user-1');

      const result = await AuthService.canControlRoom('user-1', 'room-host-true');

      expect(result).toBe(true);
    });

    it('devuelve false cuando el host es otro usuario', async () => {
      // Usamos OTRO roomId para no reutilizar el caché del caso anterior
      RedisServiceMock.getRoomHost.mockResolvedValue('other-user');

      const result = await AuthService.canControlRoom('user-1', 'room-host-false');

      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getHostUserId
  // ---------------------------------------------------------------------------
  describe('getHostUserId', () => {
    it('devuelve null si roomId no es seguro', async () => {
      isSafeIdMock.mockReturnValue(false);

      const result = await AuthService.getHostUserId('!!invalid-room');

      expect(result).toBeNull();
      expect(RedisServiceMock.getRoomHost).not.toHaveBeenCalled();
    });

    it('devuelve el host desde Redis cuando existe', async () => {
      RedisServiceMock.getRoomHost.mockResolvedValue('host-user');

      const result = await AuthService.getHostUserId('room-get-host-1');

      expect(result).toBe('host-user');
      expect(RedisServiceMock.getRoomHost).toHaveBeenCalledWith('room-get-host-1');
    });

    it('devuelve null cuando no hay host en Redis', async () => {
      RedisServiceMock.getRoomHost.mockResolvedValue(null);

      const result = await AuthService.getHostUserId('room-get-host-2');

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // maybeReleaseHost
  // ---------------------------------------------------------------------------
  describe('maybeReleaseHost', () => {
    it('devuelve false si roomId o userId no son seguros', async () => {
      isSafeIdMock.mockReturnValue(false);

      const result = await AuthService.maybeReleaseHost('roomX', 'userX');

      expect(result).toBe(false);
      expect(RedisServiceMock.getRoomHost).not.toHaveBeenCalled();
      expect(RedisServiceMock.clearRoomHost).not.toHaveBeenCalled();
    });

    it('devuelve false si el usuario no es el host actual', async () => {
      // RoomId único para que no haya entrada previa en caché
      RedisServiceMock.getRoomHost.mockResolvedValue('other-user');

      const result = await AuthService.maybeReleaseHost('room-not-host', 'user-1');

      // Puede usar caché en ejecuciones futuras, pero aquí debe consultar Redis una vez
      expect(result).toBe(false);
      expect(RedisServiceMock.clearRoomHost).not.toHaveBeenCalled();
    });

    it('borra el host y devuelve true cuando el usuario es el host actual', async () => {
      // RoomId único para este escenario
      RedisServiceMock.getRoomHost.mockResolvedValue('user-1');

      const result = await AuthService.maybeReleaseHost('room-host-release', 'user-1');

      expect(RedisServiceMock.clearRoomHost).toHaveBeenCalledWith('room-host-release');
      expect(result).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // ensureCanControlPlayback - validaciones de parámetros
  // ---------------------------------------------------------------------------
  describe('ensureCanControlPlayback - validaciones', () => {
    it('lanza AuthError INVALID_ROOM_ID cuando roomId no es seguro', async () => {
      isSafeIdMock.mockReturnValueOnce(false);

      await expect(
        AuthService.ensureCanControlPlayback({
          roomId: '!!invalid',
          accessToken: 'token-123',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_ROOM_ID',
        status: 400,
      });
    });

    it('lanza AuthError UNAUTHORIZED cuando falta accessToken', async () => {
      isSafeIdMock.mockReturnValue(true);

      await expect(
        AuthService.ensureCanControlPlayback({
          roomId: 'room-1',
          accessToken: null,
        }),
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        status: 401,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // ensureCanControlPlayback - mapping de errores del queueMembershipClient
  // ---------------------------------------------------------------------------
  describe('ensureCanControlPlayback - mapeo de errores de queueMembershipClient', () => {
    it('mapea 404 a MEMBERSHIP_NOT_FOUND', async () => {
      const err = new Error('Not found');
      err.response = { status: 404, data: {} };
      queueMembershipClientMock.getMyMembership.mockRejectedValue(err);

      await expect(
        AuthService.ensureCanControlPlayback({
          roomId: 'room-404',
          accessToken: 'token',
        }),
      ).rejects.toMatchObject({
        code: 'MEMBERSHIP_NOT_FOUND',
        status: 404,
      });
    });

    it('mapea 401 a UNAUTHORIZED', async () => {
      const err = new Error('Unauthorized');
      err.response = { status: 401, data: {} };
      queueMembershipClientMock.getMyMembership.mockRejectedValue(err);

      await expect(
        AuthService.ensureCanControlPlayback({
          roomId: 'room-401',
          accessToken: 'token',
        }),
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        status: 401,
      });
    });

    it('mapea 403 a FORBIDDEN', async () => {
      const err = new Error('Forbidden');
      err.response = { status: 403, data: {} };
      queueMembershipClientMock.getMyMembership.mockRejectedValue(err);

      await expect(
        AuthService.ensureCanControlPlayback({
          roomId: 'room-403',
          accessToken: 'token',
        }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
    });

    it('mapea otros status a QUEUE_SERVICE_ERROR usando data.message', async () => {
      const err = new Error('Server error');
      err.response = {
        status: 500,
        data: { message: 'Queue service exploded' },
      };
      queueMembershipClientMock.getMyMembership.mockRejectedValue(err);

      await expect(
        AuthService.ensureCanControlPlayback({
          roomId: 'room-500',
          accessToken: 'token',
        }),
      ).rejects.toMatchObject({
        code: 'QUEUE_SERVICE_ERROR',
        status: 500,
        message: 'Queue service exploded',
      });
    });

    it('mapea ECONNREFUSED a QUEUE_SERVICE_UNAVAILABLE', async () => {
      const err = new Error('ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      queueMembershipClientMock.getMyMembership.mockRejectedValue(err);

      await expect(
        AuthService.ensureCanControlPlayback({
          roomId: 'room-net',
          accessToken: 'token',
        }),
      ).rejects.toMatchObject({
        code: 'QUEUE_SERVICE_UNAVAILABLE',
        status: 503,
      });
    });

    it('mapea errores genéricos a AUTH_UNKNOWN_ERROR', async () => {
      const err = new Error('boom');
      queueMembershipClientMock.getMyMembership.mockRejectedValue(err);

      await expect(
        AuthService.ensureCanControlPlayback({
          roomId: 'room-x',
          accessToken: 'token',
        }),
      ).rejects.toMatchObject({
        code: 'AUTH_UNKNOWN_ERROR',
        status: 500,
        message: 'boom',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // ensureCanControlPlayback - éxito / permisos
  // ---------------------------------------------------------------------------
  describe('ensureCanControlPlayback - éxito y permisos', () => {
    it('devuelve membership cuando el usuario es host', async () => {
      const membership = {
        roomId: 'room-1',
        roles: ['host'],
        can_control_playback: false,
      };
      queueMembershipClientMock.getMyMembership.mockResolvedValue(membership);

      const result = await AuthService.ensureCanControlPlayback({
        roomId: 'room-1',
        accessToken: 'token',
      });

      expect(queueMembershipClientMock.getMyMembership).toHaveBeenCalledWith({
        roomId: 'room-1',
        accessToken: 'token',
      });
      expect(result).toBe(membership);
    });

    it('devuelve membership cuando can_control_playback es true aunque no sea host', async () => {
      const membership = {
        roomId: 'room-1',
        roles: ['speaker'],
        can_control_playback: true,
      };
      queueMembershipClientMock.getMyMembership.mockResolvedValue(membership);

      const result = await AuthService.ensureCanControlPlayback({
        roomId: 'room-1',
        accessToken: 'token',
      });

      expect(result).toBe(membership);
    });

    it('lanza ROOM_CONTROL_FORBIDDEN cuando no es host ni tiene can_control_playback', async () => {
      const membership = {
        roomId: 'room-1',
        roles: ['listener'],
        can_control_playback: false,
      };
      queueMembershipClientMock.getMyMembership.mockResolvedValue(membership);

      await expect(
        AuthService.ensureCanControlPlayback({
          roomId: 'room-1',
          accessToken: 'token',
        }),
      ).rejects.toMatchObject({
        code: 'ROOM_CONTROL_FORBIDDEN',
        status: 403,
      });
    });
  });
});
