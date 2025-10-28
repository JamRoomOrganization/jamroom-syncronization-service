// src/config/redis.js
import { createClient } from 'redis';
import Redlock from 'redlock';
import dotenv from 'dotenv';
dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Cliente principal para estado de sala (hGetAll, hSet, expire, etc.)
export const redisClient = createClient({
  url: REDIS_URL,
});
redisClient.on('connect', () => {
  console.log('[redis] main connected');
});
redisClient.on('error', (err) => {
  console.error('[redis] main error', err);
});

// Clientes dedicados a pub/sub para el adapter de Socket.IO
export const pubClient = createClient({
  url: REDIS_URL,
});
pubClient.on('error', (err) => {
  console.error('[redis] pub error', err);
});

export const subClient = createClient({
  url: REDIS_URL,
});
subClient.on('error', (err) => {
  console.error('[redis] sub error', err);
});

export const redlock = new Redlock([redisClient], {
  retryCount: 5,
  retryDelay: 200, // ms entre intentos
});


export async function initRedis() {
  const connectOps = [];

  if (!redisClient.isOpen) {
    connectOps.push(redisClient.connect());
  }
  if (!pubClient.isOpen) {
    connectOps.push(pubClient.connect());
  }
  if (!subClient.isOpen) {
    connectOps.push(subClient.connect());
  }

  if (connectOps.length > 0) {
    await Promise.all(connectOps);
  }

  console.log('[redis] initRedis done');
}


export async function shutdownRedis() {
  const closeOps = [];

  if (subClient.isOpen) {
    closeOps.push(subClient.quit());
  }
  if (pubClient.isOpen) {
    closeOps.push(pubClient.quit());
  }
  if (redisClient.isOpen) {
    closeOps.push(redisClient.quit());
  }

  await Promise.allSettled(closeOps);
  console.log('[redis] shutdown complete');
}
