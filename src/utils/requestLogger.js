import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';

const asyncLocalStorage = new AsyncLocalStorage();

const generateRandomSegment = () => randomBytes(4).toString('hex');

const generateRequestId = (prefix) =>
    `${prefix}-${Date.now()}-${generateRandomSegment()}`;

export const requestLogger = (req, res, next) => {
    const existingId = req.headers['x-request-id'];
    const requestId =
        typeof existingId === 'string' && existingId.length > 0
            ? existingId
            : generateRequestId('req');

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

export const withWsRequestId = (handler) => {
    return (...args) => {
        const wsReqId = generateRequestId('ws');
        asyncLocalStorage.run({ requestId: wsReqId }, () => handler(...args));
    };
};
