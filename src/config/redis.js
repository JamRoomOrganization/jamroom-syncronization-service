// src/config/redis.js
import { createClient, createCluster } from 'redis';
import Redlock from 'redlock';
import dotenv from 'dotenv';
dotenv.config();

const REDIS_MODE = process.env.REDIS_MODE || 'standalone'; // standalone | sentinel | cluster | nodes

const RAILWAY_REDIS_URL = process.env.RAILWAY_REDIS_URL || process.env.REDIS_PUBLIC_URL;
const RAILWAY_REDIS_HOST = process.env.RAILWAY_REDIS_HOST;
const RAILWAY_REDIS_PORT = process.env.RAILWAY_REDIS_PORT;
const RAILWAY_REDIS_PASSWORD = process.env.RAILWAY_REDIS_PASSWORD;

const REDIS_URL = RAILWAY_REDIS_URL || process.env.REDIS_URL; // Prefer public Railway URL when present
const REDIS_HOST = RAILWAY_REDIS_HOST || process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number.parseInt(RAILWAY_REDIS_PORT || process.env.REDIS_PORT || '6379', 10);
const REDIS_TLS = process.env.REDIS_TLS === 'true';
const REDIS_PASSWORD = RAILWAY_REDIS_PASSWORD || process.env.REDIS_PASSWORD || undefined;


// Multi-node configuration (for Redlock with ElastiCache Valkey or similar)
// Format: "host1:port1,host2:port2,host3:port3"
const REDIS_NODES = process.env.REDIS_NODES;
const REDIS_CLUSTER_MODE = process.env.REDIS_CLUSTER_MODE === 'true';

// Redlock configuration
const REDLOCK_ENABLED = process.env.REDLOCK_ENABLED !== 'false'; // Default: enabled
const LOCK_TTL_MS = Number.parseInt(process.env.LOCK_TTL_MS || '5000', 10); // Default: 5000ms
const REDLOCK_RETRY_COUNT = Number.parseInt(process.env.REDLOCK_RETRY_COUNT || '10', 10);
const REDLOCK_RETRY_DELAY = Number.parseInt(process.env.REDLOCK_RETRY_DELAY || '200', 10);
const REDLOCK_RETRY_JITTER = Number.parseInt(process.env.REDLOCK_RETRY_JITTER || '200', 10);

// Sentinel configuration
const REDIS_SENTINELS = process.env.REDIS_SENTINELS; // JSON array: [{"host":"h1","port":26379}]
const REDIS_MASTER_NAME = process.env.REDIS_MASTER_NAME || 'mymaster';

// Cluster configuration (legacy JSON format)
const REDIS_CLUSTER_NODES = process.env.REDIS_CLUSTER_NODES; // JSON array: [{"host":"h1","port":6379}]

// NOTE: Validate required ENV vars based on mode
function validateRedisConfig() {
  // If REDIS_NODES is provided, auto-detect mode
  if (REDIS_NODES && !process.env.REDIS_MODE) {
    console.log('[redis] REDIS_NODES detected, auto-configuring multi-node mode');
  }

  if (REDIS_MODE === 'sentinel' && !REDIS_SENTINELS) {
    throw new Error('[redis] REDIS_SENTINELS required for sentinel mode');
  }
  if (REDIS_MODE === 'cluster' && !REDIS_CLUSTER_NODES && !REDIS_NODES) {
    throw new Error('[redis] REDIS_CLUSTER_NODES or REDIS_NODES required for cluster mode');
  }
  if (REDIS_MODE === 'standalone' && !REDIS_URL && !REDIS_NODES) {
    // Fallback to REDIS_HOST/REDIS_PORT is allowed, so this is now OK
    console.log(`[redis] Using fallback configuration: ${REDIS_HOST}:${REDIS_PORT}`);
  }
  if (REDIS_MODE === 'nodes' && !REDIS_NODES) {
    throw new Error('[redis] REDIS_NODES required for nodes mode');
  }
}

validateRedisConfig();

// NOTE: Common socket options for resilience in production
const socketOptions = {
  connectTimeout: 10000, // 10s connection timeout
  keepAlive: 5000, // ✅ Mantener conexión viva cada 5s
  reconnectStrategy: (retries) => {
    if (retries > 10) {
      console.error('[redis] Max reconnect attempts reached (10)');
      return new Error('Max reconnect attempts exceeded');
    }
    // ✅ Backoff exponencial: 100ms, 200ms, 400ms, ..., max 3000ms
    const delay = Math.min(100 * Math.pow(2, retries), 3000);
    console.log(`[redis] Reconnecting in ${delay}ms (attempt ${retries + 1})`);
    return delay;
  },
  tls: REDIS_TLS,
  rejectUnauthorized: process.env.NODE_ENV === 'production',
};

const commandOptions = {
  commandTimeout: 5000, // 5s per command
};

// NOTE: Create Redis client configuration based on deployment mode
function createRedisConfig() {
  const baseConfig = {
    password: REDIS_PASSWORD,
    socket: socketOptions,
    ...commandOptions,
  };

  if (REDIS_MODE === 'sentinel') {
    const sentinels = JSON.parse(REDIS_SENTINELS);
    return {
      ...baseConfig,
      sentinels: sentinels.map(s => ({ host: s.host, port: s.port })),
      name: REDIS_MASTER_NAME,
    };
  }

  if (REDIS_MODE === 'cluster' || (REDIS_CLUSTER_MODE && REDIS_NODES)) {
    // NOTE: For cluster mode, we use createCluster instead of createClient
    let nodes;
    if (REDIS_NODES) {
      // Parse REDIS_NODES format: "host1:port1,host2:port2,host3:port3"
      nodes = REDIS_NODES.split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(node => {
          const [host, portStr] = node.split(':');
          const port = Number(portStr || 6379);
          return { host, port };
        });
    } else {
      // Legacy JSON format
      nodes = JSON.parse(REDIS_CLUSTER_NODES);
    }

    return {
      rootNodes: nodes.map(n => ({ socket: { host: n.host, port: n.port, ...socketOptions } })),
      defaults: {
        password: REDIS_PASSWORD,
        ...commandOptions,
      },
    };
  }

  // standalone mode (or nodes mode - we'll use first node for primary client)
  if (REDIS_NODES && !REDIS_CLUSTER_MODE) {
    // Parse first node from REDIS_NODES for primary connection
    const firstNode = REDIS_NODES.split(',')[0].trim();
    const [host, portStr] = firstNode.split(':');
    const port = Number(portStr || 6379);

    return {
      ...baseConfig,
      socket: {
        ...socketOptions,
        host,
        port,
      },
    };
  }

  // Traditional standalone with REDIS_URL or fallback to REDIS_HOST/REDIS_PORT
  if (REDIS_URL) {
    return {
      ...baseConfig,
      url: REDIS_URL,
    };
  }

  // Fallback to individual host/port configuration
  return {
    ...baseConfig,
    socket: {
      ...socketOptions,
      host: REDIS_HOST,
      port: REDIS_PORT,
    },
  };
}

// NOTE: Helper to create a client based on mode
function createRedisClientForMode() {
  if (REDIS_MODE === 'cluster' || (REDIS_CLUSTER_MODE && REDIS_NODES)) {
    return createCluster(createRedisConfig());
  }
  return createClient(createRedisConfig());
}

// Cliente principal para estado de sala (hGetAll, hSet, expire, etc.)
export const redisClient = createRedisClientForMode();
redisClient.on('connect', () => {
  console.log(`[redis] main connected (mode: ${REDIS_MODE})`);
});
redisClient.on('error', (err) => {
  console.error('[redis] main error', err.message);
});
redisClient.on('reconnecting', () => {
  console.warn('[redis] main reconnecting...');
});
redisClient.on('ready', () => {
  console.log('[redis] main client ready');
});

// Clientes dedicados a pub/sub para el adapter de Socket.IO
export const pubClient = createRedisClientForMode();
pubClient.on('error', (err) => {
  console.error('[redis] pub client error', err.message);

});
pubClient.on('reconnecting', () => {
  console.warn('[redis] pub client reconnecting...');
});
pubClient.on('ready', () => {
  console.log('[redis] pub client ready');
});

export const subClient = createRedisClientForMode();
subClient.on('error', (err) => {
  console.error('[redis] sub client error', err.message);
});
subClient.on('reconnecting', () => {
  console.warn('[redis] sub client reconnecting...');
});
subClient.on('ready', () => {
  console.log('[redis] sub client ready');
});

// NOTE: Redlock configuration for distributed locks across Redis instances
// - In standalone mode: uses single client (dev/staging)
// - In sentinel/cluster mode: should ideally use multiple independent Redis instances for quorum
// - In nodes mode (REDIS_NODES): creates separate client per node for true quorum
// - driftFactor accounts for clock drift between servers (1%)
// - automaticExtensionThreshold prevents locks from expiring during long operations
// WARNING: Redlock with single client cannot achieve true quorum, may fail under load

function createRedlockClients() {
  // If REDIS_NODES is provided and not in cluster mode, create one client per node for Redlock
  if (REDIS_NODES && !REDIS_CLUSTER_MODE) {
    const nodesList = REDIS_NODES.split(',')
      .map(s => s.trim())
      .filter(Boolean);

    console.log(`[redis] Creating ${nodesList.length} Redlock clients for quorum`);

    return nodesList.map((node) => {
      const [host, portStr] = node.split(':');
      const port = Number(portStr || 6379);

      const client = createClient({
        password: REDIS_PASSWORD,
        socket: {
          ...socketOptions,
          host,
          port,
        },
        ...commandOptions,
      });

      client.on('error', (err) => {
        console.error(`[redis] Redlock client ${host}:${port} error:`, err.message);
      });

      return client;
    });
  }

  // For other modes, use primary client (backward compatibility)
  return [redisClient];
}

const redlockClients = createRedlockClients();

export const redlock = new Redlock(redlockClients, {
  retryCount: REDLOCK_RETRY_COUNT,
  retryDelay: REDLOCK_RETRY_DELAY,
  retryJitter: REDLOCK_RETRY_JITTER,
  driftFactor: 0.01, // 1% drift tolerance
  automaticExtensionThreshold: Math.floor(LOCK_TTL_MS * 0.2), // Extend lock at 20% remaining
});

redlock.on('error', (err) => {
  // NOTE: Redlock errors are expected during normal operation (lock conflicts)
  // Only log quorum failures which indicate infrastructure issues
  if (err.message && err.message.includes('quorum')) {
    console.error('[redlock] ⚠️  Quorum not achieved - check Redis cluster health', {
      error: err.message,
      mode: REDIS_MODE,
      clients: redlockClients.length,
      retryCount: REDLOCK_RETRY_COUNT,
      lockTtl: LOCK_TTL_MS,
    });
  }
});

// Export config for use in services
export const REDLOCK_CONFIG = {
  ENABLED: REDLOCK_ENABLED,
  LOCK_TTL_MS,
  RETRY_COUNT: REDLOCK_RETRY_COUNT,
  RETRY_DELAY: REDLOCK_RETRY_DELAY,
};

// Export Redlock clients for debugging/monitoring
export { redlockClients };


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

  // Connect all Redlock clients if they're separate from the main client
  if (REDIS_NODES && !REDIS_CLUSTER_MODE) {
    redlockClients.forEach((client, index) => {
      if (!client.isOpen && client !== redisClient) {
        connectOps.push(
          client.connect().then(() => {
            console.log(`[redis] Redlock client ${index + 1}/${redlockClients.length} connected`);
          })
        );
      }
    });
  }

  if (connectOps.length > 0) {
    await Promise.all(connectOps);
  }

  console.log(`[redis] initRedis done (mode: ${REDIS_MODE}, TLS: ${REDIS_TLS}, nodes: ${redlockClients.length})`);
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

  // Close all Redlock clients if they're separate
  if (REDIS_NODES && !REDIS_CLUSTER_MODE) {
    redlockClients.forEach((client) => {
      if (client.isOpen && client !== redisClient) {
        closeOps.push(client.quit());
      }
    });
  }

  await Promise.allSettled(closeOps);
  console.log('[redis] shutdown complete');
}

