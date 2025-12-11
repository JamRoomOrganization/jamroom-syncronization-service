import { jest } from '@jest/globals';
import queueClient from './queueClient.js';

// Base URL esperada según la misma lógica que usa queueClient internamente
const EXPECTED_BASE_URL =
  process.env.QUEUE_SERVICE_URL || 'http://localhost:3000';

describe('queueClient helpers', () => {
  it('_normalizeBaseUrl maneja url inválida o vacía usando localhost', () => {
    const fn = queueClient._normalizeBaseUrl;

    expect(fn(undefined)).toBe('http://localhost:3000');
    expect(fn(null)).toBe('http://localhost:3000');
    expect(fn(123)).toBe('http://localhost:3000');
  });

  it('_normalizeBaseUrl elimina slashes finales y conserva protocolo', () => {
    const fn = queueClient._normalizeBaseUrl;

    expect(fn('http://example.com///')).toBe('http://example.com');
    expect(fn('https://example.com/')).toBe('https://example.com');
  });

  it('_normalizeBaseUrl agrega http:// cuando no hay protocolo', () => {
    const fn = queueClient._normalizeBaseUrl;

    expect(fn('example.com')).toBe('http://example.com');
    expect(fn('example.com/')).toBe('http://example.com');
  });

  it('_normalizePath normaliza path nulo o inválido a "/"', () => {
    const fn = queueClient._normalizePath;

    expect(fn(undefined)).toBe('/');
    expect(fn(null)).toBe('/');
    expect(fn(123)).toBe('/');
  });

  it('_normalizePath asegura que empiece con / y colapsa slashes múltiples', () => {
    const fn = queueClient._normalizePath;

    expect(fn('path')).toBe('/path');
    expect(fn('/path')).toBe('/path');
    expect(fn('//api///v1//rooms')).toBe('/api/v1/rooms');
    expect(fn('///api///v1//rooms///')).toBe('/api/v1/rooms/');
  });
});

describe('queueClient HTTP methods', () => {
  let fetchMock;
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;

    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------
  // GET
  // ---------------------------
  it('get realiza un GET exitoso y retorna la respuesta', async () => {
    const responseMock = {
      ok: true,
      status: 200,
      text: jest.fn(),
    };

    fetchMock.mockResolvedValue(responseMock);

    const result = await queueClient.get('/api/rooms', {
      accessToken: 'token-123',
      headers: {
        'X-Custom': 'abc',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];

    expect(url).toBe(`${EXPECTED_BASE_URL}/api/rooms`);
    expect(options).toEqual({
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Custom': 'abc',
        Authorization: 'Bearer token-123',
      },
    });

    expect(result).toBe(responseMock);
  });

  it('get lanza QueueServiceError cuando response.ok es false', async () => {
    const textMock = jest.fn().mockResolvedValue('error-body');

    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: textMock,
    });

    await expect(queueClient.get('/api/fail')).rejects.toMatchObject({
      name: 'QueueServiceError',
      statusCode: 500,
      responseData: 'error-body',
    });

    expect(textMock).toHaveBeenCalled();
  });

  it('get envuelve errores de red en QueueServiceError con statusCode 0', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(queueClient.get('/api/fail')).rejects.toMatchObject({
      name: 'QueueServiceError',
      statusCode: 0,
      responseData: { originalError: 'network down' },
    });

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  // ---------------------------
  // POST
  // ---------------------------
  it('post realiza un POST exitoso con body JSON y retorna la respuesta', async () => {
    const responseMock = {
      ok: true,
      status: 201,
      text: jest.fn(),
    };

    fetchMock.mockResolvedValue(responseMock);

    const body = { foo: 'bar' };

    const result = await queueClient.post('api/rooms', body, {
      accessToken: 'token-xyz',
      headers: { 'X-Trace-Id': 'trace-1' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];

    expect(url).toBe(`${EXPECTED_BASE_URL}/api/rooms`);
    expect(options).toEqual({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Trace-Id': 'trace-1',
        Authorization: 'Bearer token-xyz',
      },
      body: JSON.stringify(body),
    });

    expect(result).toBe(responseMock);
  });

  it('post lanza QueueServiceError cuando response.ok es false', async () => {
    const textMock = jest.fn().mockResolvedValue('post-error');

    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: textMock,
    });

    await expect(
      queueClient.post('/api/rooms', { a: 1 }),
    ).rejects.toMatchObject({
      name: 'QueueServiceError',
      statusCode: 400,
      responseData: 'post-error',
    });
  });

  it('post envuelve errores de red en QueueServiceError con statusCode 0', async () => {
    fetchMock.mockRejectedValue(new Error('post network error'));

    await expect(
      queueClient.post('/api/rooms', { foo: 'bar' }),
    ).rejects.toMatchObject({
      name: 'QueueServiceError',
      statusCode: 0,
      responseData: { originalError: 'post network error' },
    });

    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  // ---------------------------
  // DELETE
  // ---------------------------
  it('delete realiza un DELETE exitoso y retorna la respuesta', async () => {
    const responseMock = {
      ok: true,
      status: 204,
      text: jest.fn(),
    };

    fetchMock.mockResolvedValue(responseMock);

    const result = await queueClient.delete('/api/rooms/room-1', {
      accessToken: 'token-del',
      headers: { 'X-Source': 'test' },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];

    expect(url).toBe(`${EXPECTED_BASE_URL}/api/rooms/room-1`);
    expect(options).toEqual({
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-Source': 'test',
        Authorization: 'Bearer token-del',
      },
    });

    expect(result).toBe(responseMock);
  });

  it('delete lanza QueueServiceError cuando response.ok es false', async () => {
    const textMock = jest.fn().mockResolvedValue('delete-error');

    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: textMock,
    });

    await expect(
      queueClient.delete('/api/rooms/room-missing'),
    ).rejects.toMatchObject({
      name: 'QueueServiceError',
      statusCode: 404,
      responseData: 'delete-error',
    });
  });

  it('delete envuelve errores de red en QueueServiceError con statusCode 0', async () => {
    fetchMock.mockRejectedValue(new Error('delete network error'));

    await expect(
      queueClient.delete('/api/rooms/room-1'),
    ).rejects.toMatchObject({
      name: 'QueueServiceError',
      statusCode: 0,
      responseData: { originalError: 'delete network error' },
    });

    expect(consoleErrorSpy).toHaveBeenCalled();
  });
});

