import { AsyncLocalStorage } from 'async_hooks';

const asyncLocalStorage = new AsyncLocalStorage();

export const requestLogger = (req, res, next) => {
  const requestId =
    req.headers['x-request-id'] ||
    `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  asyncLocalStorage.run({ requestId }, () => {
    console.log(`[${requestId}] ${req.method} ${req.originalUrl}`);
    next();
  });
};

export const getRequestId = () => {
  const store = asyncLocalStorage.getStore();
  return store?.requestId || 'unknown';
};

// Wrapper para eventos Socket.IO: cada evento corre con un requestId propio
export const withWsRequestId = (handler) => {
  return (...args) => {
    const wsReqId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    asyncLocalStorage.run({ requestId: wsReqId }, () => handler(...args));
  };
};

