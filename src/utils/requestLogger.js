export const requestLogger = (req, _res, next) => {
    const requestId =
        req.headers['x-request-id'] || `req-${Date.now()}`;

    req.requestId = requestId;

    console.log(`[${requestId}] ${req.method} ${req.originalUrl}`);

    next();
};
