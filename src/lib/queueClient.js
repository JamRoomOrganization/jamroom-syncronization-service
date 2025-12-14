/**
 * Normaliza la URL base eliminando slashes finales y validando el protocolo
 * @param {string} url - URL a normalizar
 * @returns {string} URL normalizada
 */
const normalizeBaseUrl = (url) => {
    if (!url || typeof url !== 'string') {
        return 'http://localhost:3000';
    }

    // Remover slashes finales sin usar regex
    let normalized = url;
    while (normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }

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
  path = path.replaceAll(/\/+/g, '/');

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
 * Ejecuta una petición HTTP genérica con manejo de errores unificado
 * @param {string} method - HTTP method (GET, POST, DELETE)
 * @param {string} path - API path
 * @param {Object} options - Request options (headers, accessToken)
 * @param {*} [body] - Request body (for POST)
 * @returns {Promise<Response>}
 */
async function request(method, path, options = {}, body = undefined) {
  const normalizedPath = normalizePath(path);
  const url = `${getBaseUrl()}${normalizedPath}`;

  console.log(`[queueClient] ${method} ${url}`);

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (options.accessToken) {
    headers.Authorization = `Bearer ${options.accessToken}`;
  }

  const fetchOptions = { method, headers };
  if (body !== undefined) {
    fetchOptions.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, fetchOptions);

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

    console.error(`[queueClient] ${method} ${url} failed:`, error.message);

    throw new QueueServiceError(
      'Queue service unavailable',
      0,
      { originalError: error.message }
    );
  }
}

/**
 * Cliente HTTP para queue-service
 */
const queueClient = {
  /**
   * GET request
   */
  async get(path, options = {}) {
    return request('GET', path, options);
  },

  /**
   * POST request
   */
  async post(path, body, options = {}) {
    return request('POST', path, options, body);
  },

  /**
   * DELETE request
   */
  async delete(path, options = {}) {
    return request('DELETE', path, options);
  },

  /**
   * Exponer funciones de normalización para testing
   */
  _normalizeBaseUrl: normalizeBaseUrl,
  _normalizePath: normalizePath,
};

export default queueClient;

