import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

import { initRedis, shutdownRedis } from './config/redis.js';
import { registerSyncRoutes } from './controllers/syncController.js';
import { initSyncGateway } from './sockets/syncGateway.js';

dotenv.config();

const PORT = process.env.PORT || 3001;

const toArray = (value) =>
    typeof value === 'string' && value.length
        ? value.split(',').map((entry) => entry.trim()).filter(Boolean)
        : value;

async function start() {
    try {
        await initRedis();
        console.log('Redis connected');

        const app = express();
        app.use(express.json());
        app.use(
            cors({
                origin: toArray(process.env.CORS_ORIGIN) || '*',
                credentials: true,
            }),
        );

        app.get('/__health', (req, res) => {
            res.json({ ok: true });
        });

        registerSyncRoutes(app);

        app.use((req, res) => {
            console.warn('404 ->', req.method, req.originalUrl);
            res.status(404).json({
                error: 'Not found',
                method: req.method,
                url: req.originalUrl,
            });
        });

        const server = app.listen(PORT, () => {
            console.log(`Sync service running on port ${PORT}`);
        });

        const gateway = initSyncGateway(server, {
            cors: {
                origin: toArray(process.env.CORS_ORIGIN) || '*',
                methods: ['GET', 'POST'],
            },
        });

        await gateway.initialize();
        console.log('Socket.IO gateway initialized');

        const shutdown = async () => {
            console.log('Shutting down...');

            await gateway.shutdown().catch((err) => {
                console.warn('Error during gateway shutdown', err);
            });

            server.close(async () => {
                await shutdownRedis().catch((err) => {
                    console.warn('Error during Redis shutdown', err);
                });
                process.exit(0);
            });
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    } catch (error) {
        console.error('Fatal startup error', error);
        process.exit(1);
    }
}

start();
