/**
 * Cliente HTTP centralizado para comunicarse con el queue-service
 *
 * Utiliza la variable de entorno QUEUE_SERVICE_URL para determinar la base URL.
 * Si no está definida, usa http://localhost:3000 por defecto.
 *
 * Todas las peticiones incluyen timeout y headers consistentes.
 */

/**
 * Normaliza la URL base eliminando slashes finales y validando el protocolo
 * @param {string} url - URL a normalizar
 * @returns {string} URL normalizada
 */
const normalizeBaseUrl = (url) => {
  if (!url || typeof url !== 'string') {
    return 'http://localhost:3000';
  }

  // Remover slashes finales
  let normalized = url.replace(/\/+$/, '');

  // Asegurar protocolo
  if (!normalized.startsWith('http://') && !normalized.startsWith('https://')) {
    normalized = `http://${normalized}`;
  }

  return normalized;
};

/**
 * Normaliza un path eliminando slashes duplicados y asegurando que empiece con /
 * @param {string} path - Path a normalizar
 * @returns {string} Path normalizado
 */
const normalizePath = (path) => {
  if (!path || typeof path !== 'string') {
    return '/';
  }

  // Asegurar que empiece con /
  if (!path.startsWith('/')) {
    path = `/${path}`;
  }

  // Eliminar slashes duplicados
  path = path.replace(/\/+/g, '/');

  return path;
};

/**
 * Error personalizado para fallos del queue-service
 */
class QueueServiceError extends Error {
  constructor(message, statusCode, responseData) {
    super(message);
    this.name = 'QueueServiceError';
    this.statusCode = statusCode;
    this.responseData = responseData;
  }
}

// Lazy initialization para leer correctamente process.env después de dotenv.config()
let baseUrl = null;

const getBaseUrl = () => {
  if (!baseUrl) {
    baseUrl = normalizeBaseUrl(process.env.QUEUE_SERVICE_URL);
    console.log('[queueClient] Initialized with baseUrl:', baseUrl);
  }
  return baseUrl;
};

/**
 * Cliente HTTP para queue-service
 */
const queueClient = {
  /**
   * GET request
   */
  async get(path, options = {}) {
    const normalizedPath = normalizePath(path);
    const url = `${getBaseUrl()}${normalizedPath}`;

    console.log(`[queueClient] GET ${url}`);

    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (options.accessToken) {
      headers.Authorization = `Bearer ${options.accessToken}`;
    }

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new QueueServiceError(
          `Queue service error: ${response.status}`,
          response.status,
          text
        );
      }

      return response;
    } catch (error) {
      if (error instanceof QueueServiceError) {
        throw error;
      }

      console.error(`[queueClient] GET ${url} failed:`, error.message);

      throw new QueueServiceError(
        'Queue service unavailable',
        0,
        { originalError: error.message }
      );
    }
  },

  /**
   * POST request
   */
  async post(path, body, options = {}) {
    const normalizedPath = normalizePath(path);
    const url = `${getBaseUrl()}${normalizedPath}`;

    console.log(`[queueClient] POST ${url}`);

    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (options.accessToken) {
      headers.Authorization = `Bearer ${options.accessToken}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new QueueServiceError(
          `Queue service error: ${response.status}`,
          response.status,
          text
        );
      }

      return response;
    } catch (error) {
      if (error instanceof QueueServiceError) {
        throw error;
      }

      console.error(`[queueClient] POST ${url} failed:`, error.message);

      throw new QueueServiceError(
        'Queue service unavailable',
        0,
        { originalError: error.message }
      );
    }
  },

  /**
   * DELETE request
   */
  async delete(path, options = {}) {
    const normalizedPath = normalizePath(path);
    const url = `${getBaseUrl()}${normalizedPath}`;

    console.log(`[queueClient] DELETE ${url}`);

    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (options.accessToken) {
      headers.Authorization = `Bearer ${options.accessToken}`;
    }

    try {
      const response = await fetch(url, {
        method: 'DELETE',
        headers,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new QueueServiceError(
          `Queue service error: ${response.status}`,
          response.status,
          text
        );
      }

      return response;
    } catch (error) {
      if (error instanceof QueueServiceError) {
        throw error;
      }

      console.error(`[queueClient] DELETE ${url} failed:`, error.message);

      throw new QueueServiceError(
        'Queue service unavailable',
        0,
        { originalError: error.message }
      );
    }
  },

  /**
   * Exponer funciones de normalización para testing
   */
  _normalizeBaseUrl: normalizeBaseUrl,
  _normalizePath: normalizePath,
};

export default queueClient;

