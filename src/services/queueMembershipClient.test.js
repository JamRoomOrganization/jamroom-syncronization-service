// src/services/queueMembershipClient.test.js
import { jest } from '@jest/globals';

// Mocks de axios
const axiosGetMock = jest.fn();
const axiosPostMock = jest.fn();

jest.unstable_mockModule('axios', () => ({
  default: {
    get: axiosGetMock,
    post: axiosPostMock,
  },
}));

// Importar el cliente después de mockear axios
const { queueMembershipClient } = await import('./queueMembershipClient.js');

// Base URL real que usa el módulo cuando no se define QUEUE_SERVICE_URL
const BASE_URL = 'https://jamroom-queue-service-production.up.railway.app';

describe('queueMembershipClient', () => {
  let warnSpy;

  beforeEach(() => {
    axiosGetMock.mockReset();
    axiosPostMock.mockReset();

    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // getMyMembership
  // ---------------------------------------------------------------------------
  describe('getMyMembership', () => {
    it('lanza error INVALID_ROOM_ID si roomId es inválido', async () => {
      await expect(
        queueMembershipClient.getMyMembership({
          roomId: '   ', // vacío
          accessToken: 'token-123',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_ROOM_ID',
        message: 'Invalid roomId',
      });

      expect(axiosGetMock).not.toHaveBeenCalled();
    });

    it('lanza error MISSING_ACCESS_TOKEN si falta accessToken', async () => {
      await expect(
        queueMembershipClient.getMyMembership({
          roomId: 'room-1',
          accessToken: null,
        }),
      ).rejects.toMatchObject({
        code: 'MISSING_ACCESS_TOKEN',
        message: 'Missing access token',
      });

      expect(axiosGetMock).not.toHaveBeenCalled();
    });

    it('realiza GET y devuelve data en caso de éxito 2xx', async () => {
      const membership = { roomId: 'room-1', userId: 'user-1', roles: ['host'] };

      axiosGetMock.mockResolvedValue({
        data: membership,
      });

      const result = await queueMembershipClient.getMyMembership({
        roomId: 'room-1',
        accessToken: 'token-123',
      });

      expect(axiosGetMock).toHaveBeenCalledTimes(1);

      const [url, config] = axiosGetMock.mock.calls[0];

      expect(url).toBe(
        `${BASE_URL}/api/rooms/room-1/members/me`,
      );
      expect(config.headers.Authorization).toBe('Bearer token-123');
      expect(config.timeout).toBe(3000);

      expect(result).toEqual(membership);
    });

    it('loggea warning y relanza error cuando axios devuelve non-2xx con response', async () => {
      const error = new Error('Not found');
      error.response = {
        status: 404,
        data: { message: 'Membership not found' },
      };

      axiosGetMock.mockRejectedValue(error);

      await expect(
        queueMembershipClient.getMyMembership({
          roomId: 'room-1',
          accessToken: 'token-123',
        }),
      ).rejects.toBe(error);

      expect(warnSpy).toHaveBeenCalledWith(
        '[queueMembershipClient] getMyMembership non-2xx',
        {
          roomId: 'room-1',
          status: 404,
          data: { message: 'Membership not found' },
        },
      );
    });

    it('loggea warning y relanza error cuando axios falla sin response (error de red)', async () => {
      const error = new Error('Network error');

      axiosGetMock.mockRejectedValue(error);

      await expect(
        queueMembershipClient.getMyMembership({
          roomId: 'room-1',
          accessToken: 'token-123',
        }),
      ).rejects.toBe(error);

      expect(warnSpy).toHaveBeenCalledWith(
        '[queueMembershipClient] getMyMembership error',
        {
          roomId: 'room-1',
          message: 'Network error',
        },
      );
    });
  });

  // ---------------------------------------------------------------------------
  // ensureMyMembership
  // ---------------------------------------------------------------------------
  describe('ensureMyMembership', () => {
    it('lanza error INVALID_ROOM_ID si roomId es inválido', async () => {
      await expect(
        queueMembershipClient.ensureMyMembership({
          roomId: '',
          accessToken: 'token-123',
        }),
      ).rejects.toMatchObject({
        code: 'INVALID_ROOM_ID',
        message: 'Invalid roomId',
      });

      expect(axiosPostMock).not.toHaveBeenCalled();
    });

    it('lanza error MISSING_ACCESS_TOKEN si falta accessToken', async () => {
      await expect(
        queueMembershipClient.ensureMyMembership({
          roomId: 'room-1',
          accessToken: undefined,
        }),
      ).rejects.toMatchObject({
        code: 'MISSING_ACCESS_TOKEN',
        message: 'Missing access token',
      });

      expect(axiosPostMock).not.toHaveBeenCalled();
    });

    it('realiza POST y devuelve data en caso de éxito 2xx', async () => {
      const membership = { roomId: 'room-1', userId: 'user-1', roles: ['speaker'] };

      axiosPostMock.mockResolvedValue({
        data: membership,
      });

      const result = await queueMembershipClient.ensureMyMembership({
        roomId: 'room-1',
        accessToken: 'token-ensure-123',
      });

      expect(axiosPostMock).toHaveBeenCalledTimes(1);

      const [url, body, config] = axiosPostMock.mock.calls[0];

      expect(url).toBe(
        `${BASE_URL}/api/rooms/room-1/members/ensure`,
      );
      expect(body).toEqual({});
      expect(config.headers.Authorization).toBe('Bearer token-ensure-123');
      expect(config.timeout).toBe(3000);

      expect(result).toEqual(membership);
    });

    it('loggea warning y relanza error cuando axios devuelve non-2xx con response', async () => {
      const error = new Error('Conflict');
      error.response = {
        status: 409,
        data: { message: 'Already a member' },
      };

      axiosPostMock.mockRejectedValue(error);

      await expect(
        queueMembershipClient.ensureMyMembership({
          roomId: 'room-1',
          accessToken: 'token-123',
        }),
      ).rejects.toBe(error);

      expect(warnSpy).toHaveBeenCalledWith(
        '[queueMembershipClient] ensureMyMembership non-2xx',
        {
          roomId: 'room-1',
          status: 409,
          data: { message: 'Already a member' },
        },
      );
    });

    it('loggea warning y relanza error cuando axios falla sin response (error de red)', async () => {
      const error = new Error('Network down');

      axiosPostMock.mockRejectedValue(error);

      await expect(
        queueMembershipClient.ensureMyMembership({
          roomId: 'room-1',
          accessToken: 'token-123',
        }),
      ).rejects.toBe(error);

      expect(warnSpy).toHaveBeenCalledWith(
        '[queueMembershipClient] ensureMyMembership error',
        {
          roomId: 'room-1',
          message: 'Network down',
        },
      );
    });
  });
});
