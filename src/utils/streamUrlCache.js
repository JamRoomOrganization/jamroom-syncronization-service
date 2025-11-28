// src/utils/streamUrlCache.js
import NodeCache from 'node-cache';

// Cache de URLs por 1 hora
const streamUrlCache = new NodeCache({ 
    stdTTL: 3600,      // 1 hora de vida
    checkperiod: 120,   // Limpieza cada 2 minutos
    useClones: false    // Mejor performance
});

/**
 * Resuelve streamUrl con cache interno para reducir latencia
 * @param {string} trackId - ID del track de Audius
 * @returns {Promise<string|null>}
 */
export async function resolveStreamUrl(trackId) {
    if (!trackId || typeof trackId !== 'string') {
        console.warn('[streamUrlCache] trackId inválido:', trackId);
        return null;
    }

    // 🟢 Verificar cache
    const cached = streamUrlCache.get(trackId);
    if (cached) {
        console.log('[streamUrlCache] ✓ Hit de cache para:', trackId);
        return cached;
    }

    const startTime = Date.now();

    try {
        // 🟢 Resolver desde Audius con timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

        const response = await fetch(
            `https://discoveryprovider.audius.co/v1/tracks/${trackId}/stream`,
            {
                signal: controller.signal,
                redirect: 'follow',
            }
        );

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.error('[streamUrlCache] Error resolving:', {
                trackId,
                status: response.status,
                statusText: response.statusText,
            });
            return null;
        }

        const streamUrl = response.url; // URL final tras redirects
        const latency = Date.now() - startTime;

        // 🟢 Guardar en cache
        streamUrlCache.set(trackId, streamUrl);
        
        console.log('[streamUrlCache] ✓ Cached:', {
            trackId,
            latencyMs: latency,
            cacheSize: streamUrlCache.keys().length,
        });

        // ⚠️ Warning si la resolución fue lenta
        if (latency > 500) {
            console.warn('[streamUrlCache] slow_resolution', {
                trackId,
                latencyMs: latency,
            });
        }

        return streamUrl;
    } catch (err) {
        const latency = Date.now() - startTime;
        
        if (err.name === 'AbortError') {
            console.error('[streamUrlCache] Timeout resolving:', {
                trackId,
                latencyMs: latency,
            });
        } else {
            console.error('[streamUrlCache] Error:', {
                trackId,
                error: err.message,
                latencyMs: latency,
            });
        }
        
        return null;
    }
}

/**
 * Pre-cachea una lista de trackIds (útil para playlists)
 * @param {string[]} trackIds - Array de track IDs
 */
export async function precacheStreamUrls(trackIds) {
    if (!Array.isArray(trackIds) || trackIds.length === 0) {
        return;
    }

    console.log('[streamUrlCache] Precaching', trackIds.length, 'tracks...');

    const results = await Promise.allSettled(
        trackIds.map(trackId => resolveStreamUrl(trackId))
    );

    const successful = results.filter(r => r.status === 'fulfilled' && r.value).length;
    
    console.log('[streamUrlCache] Precache completado:', {
        total: trackIds.length,
        successful,
        failed: trackIds.length - successful,
    });
}

/**
 * Obtiene estadísticas del cache
 */
export function getCacheStats() {
    return {
        keys: streamUrlCache.keys().length,
        hits: streamUrlCache.getStats().hits,
        misses: streamUrlCache.getStats().misses,
        ksize: streamUrlCache.getStats().ksize,
    };
}

/**
 * Limpia el cache manualmente
 */
export function clearCache() {
    streamUrlCache.flushAll();
    console.log('[streamUrlCache] Cache limpiado');
}

