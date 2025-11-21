# Redlock Quorum Error - Investigation and Fix

## Problem Statement

The service was experiencing frequent Redlock quorum errors, particularly under rapid consecutive operations (play/pause/seek):

```
[lockRoom] Using no-op lock fallback (dev mode) { 
  requestId: 'ws-...', 
  roomId: 'room44',
  error: 'The operation was unable to achieve a quorum during its retry window.' 
}
```

## Root Causes Identified

### 1. **Single Redis Client in Redlock**
**Location**: `src/config/redis.js:138`

```javascript
const redlockClients = REDIS_MODE === 'cluster' ? [redisClient] : [redisClient];
```

**Problem**: Redlock requires quorum (majority vote) to acquire locks. With a **single client**, the quorum is 1/1. If that client experiences any latency, reconnection, or is busy processing other commands, Redlock cannot achieve quorum within the retry window.

**Impact**: High - causes lock failures under normal load.

---

### 2. **Insufficient Lock TTL (2000ms)**
**Location**: `src/services/redisService.js:106`

```javascript
async lockRoom(roomId, ttlMs = 2000) {
```

**Problem**: Operations within the lock perform multiple async operations:
- `getRoomState()` - Redis HGETALL (~10-50ms)
- `nextVersion()` - Redis INCR + EXPIRE (~10-30ms)
- `setRoomHostIfEmpty()` - Redis SETNX + EXPIRE (~10-30ms)
- `setRoomState()` - Redis HSET + EXPIRE (~10-50ms)
- `publish()` x2 - Redis PUBLISH (~10-30ms each)

**Total estimated time**: 60-220ms under normal conditions, but can spike to 500-1000ms under load or network latency.

With Redlock's `driftFactor` (1%) and `automaticExtensionThreshold` (500ms), a 2000ms lock can expire if:
- Operations take >1500ms (2000 - 500 threshold)
- Network latency spikes
- Redis is reconnecting

**Impact**: High - locks expire mid-operation, causing race conditions.

---

### 3. **Lock TTL Not Configurable**
**Problem**: No way to adjust TTL without code changes.

**Impact**: Medium - cannot tune for different environments (fast local vs slow cloud).

---

### 4. **Silent Fallback in Development**
**Location**: `src/services/redisService.js:133`

```javascript
console.warn('[lockRoom] Using no-op lock fallback (dev mode)', {
  requestId: getRequestId(),
  roomId,
  error: err.message,
});
```

**Problem**: Warning is logged but doesn't indicate severity. Developers may not notice the underlying issue until production.

**Impact**: Medium - masks problems during development.

---

### 5. **No Metrics/Monitoring for Lock Failures**
**Problem**: No counters or alerts for lock acquisition failures.

**Impact**: Low - but prevents proactive monitoring.

---

## Solutions Implemented

### ✅ 1. Configurable Lock TTL (ENV-based)
**File**: `src/config/redis.js`

Added environment variables:
```bash
LOCK_TTL_MS=5000          # Default 5000ms (up from 2000ms)
REDLOCK_RETRY_COUNT=10    # Configurable retry count
REDLOCK_RETRY_DELAY=200   # Configurable retry delay
REDLOCK_RETRY_JITTER=200  # Configurable jitter
REDLOCK_ENABLED=true      # Allow disabling in dev/test
```

**Calculation**:
- Typical operation time: 60-220ms
- Safety margin: 2-3x
- Network latency buffer: +1000ms
- **New default**: 5000ms

With `automaticExtensionThreshold` now at 20% (1000ms), Redlock will extend the lock if operations approach the limit.

---

### ✅ 2. Enhanced Error Logging
**File**: `src/services/redisService.js:106-195`

**Before**:
```javascript
console.warn('[lockRoom] Using no-op lock fallback (dev mode)', {
  requestId: getRequestId(),
  roomId,
  error: err.message,
});
```

**After**:
```javascript
console.error('[lockRoom] Failed to acquire lock', {
  requestId: getRequestId(),
  roomId,
  ttlMs,
  error: err.message,
  quorumError: isQuorumError,
  timeout: isTimeout,
  redlockConfig: {
    retryCount: REDLOCK_CONFIG.RETRY_COUNT,
    retryDelay: REDLOCK_CONFIG.RETRY_DELAY,
    lockTtl: REDLOCK_CONFIG.LOCK_TTL_MS,
  },
  stack: err.stack?.split('\n').slice(0, 3).join('\n'),
});
```

Now includes:
- ✅ TTL used
- ✅ Error classification (quorum vs timeout)
- ✅ Redlock configuration snapshot
- ✅ Stack trace (first 3 lines)
- ✅ Visible warning emoji in dev fallback

---

### ✅ 3. Slow Lock Detection
**File**: `src/services/redisService.js:130`

```javascript
const lockStartTime = Date.now();
const lock = await redlock.acquire([lockKey(roomId)], ttlMs);
const lockAcquireTime = Date.now() - lockStartTime;

if (lockAcquireTime > 500) {
  console.warn('[lockRoom] Slow lock acquisition detected', {
    requestId: getRequestId(),
    roomId,
    ttlMs,
    acquireTimeMs: lockAcquireTime,
  });
}
```

Detects contention or latency issues before they become critical.

---

### ✅ 4. REDLOCK_ENABLED Flag
**File**: `src/config/redis.js:16`

Allows disabling Redlock entirely in dev/test environments:

```bash
REDLOCK_ENABLED=false npm start
```

Use cases:
- Local development without Redis
- Integration tests with mocked Redis
- Single-instance deployments

---

### ✅ 5. Production Fail-Fast
**File**: `src/services/redisService.js:168`

**Before**: Silent fallback in production (dangerous!)

**After**:
```javascript
if (process.env.NODE_ENV === 'production') {
  // In production, fail fast - don't allow operations without locks
  throw new Error(`Distributed lock unavailable for room ${roomId}: ${err.message}`);
}
```

Operations will **fail explicitly** rather than proceed with race conditions.

---

## Testing & Validation

### 1. Local Testing (Redis Up)

**Setup**:
```bash
docker run -d --name redis-local -p 6379:6379 redis:7-alpine

REDIS_URL=redis://localhost:6379 \
NODE_ENV=development \
LOCK_TTL_MS=5000 \
REDLOCK_ENABLED=true \
npm start
```

**Tests**:
```bash
# Health check
curl -s http://localhost:3001/health | jq

# Rapid control operations
for i in {1..10}; do
  curl -X POST http://localhost:3001/v1/rooms/room44/play \
    -H "Content-Type: application/json" \
    -d '{"userId":"u1","trackId":"t1","startPositionMs":0}' &
  
  curl -X POST http://localhost:3001/v1/rooms/room44/seek \
    -H "Content-Type: application/json" \
    -d '{"userId":"u1","positionMs":5000}' &
done
wait

# Check for stuck locks
docker exec -it redis-local redis-cli KEYS 'lock:room:*'
docker exec -it redis-local redis-cli TTL lock:room:room44
```

**Expected**:
- ✅ No "quorum" errors in logs
- ✅ All requests succeed (HTTP 200)
- ✅ No stuck locks (KEYS returns empty or expired)

---

### 2. Local Testing (Redis Down)

**Setup**:
```bash
docker stop redis-local

NODE_ENV=development \
REDLOCK_ENABLED=true \
npm start
```

**Expected**:
- ✅ Service starts (doesn't crash)
- ✅ Operations log `⚠️  USING NO-OP LOCK FALLBACK (dev mode)`
- ✅ `/health` returns 503 (degraded)

---

### 3. Redlock Disabled

**Setup**:
```bash
REDLOCK_ENABLED=false \
NODE_ENV=development \
npm start
```

**Expected**:
- ✅ Service starts
- ✅ Operations log `⚠️  Redlock DISABLED by config`
- ✅ All requests succeed (no lock errors)

---

### 4. Production Simulation

**Setup**:
```bash
docker stop redis-local

NODE_ENV=production \
REDLOCK_ENABLED=true \
npm start
```

**Tests**:
```bash
curl -X POST http://localhost:3001/v1/rooms/room44/play \
  -H "Content-Type: application/json" \
  -d '{"userId":"u1","trackId":"t1","startPositionMs":0}'
```

**Expected**:
- ✅ HTTP 500 (Internal Error)
- ✅ Logs: `Distributed lock unavailable for room room44`
- ✅ No silent fallback

---

## Monitoring Recommendations

### Key Metrics to Track

1. **Lock Acquisition Time**
   - `lockAcquireTime` from slow lock warnings
   - **Alert**: If P95 > 500ms

2. **Lock Failures**
   - Count of "Failed to acquire lock" errors
   - **Alert**: If > 1% of operations

3. **Quorum Errors**
   - Count of `quorumError: true` logs
   - **Alert**: If any in production

4. **Stuck Locks**
   - Redis monitoring: `KEYS lock:room:*` count
   - **Alert**: If count grows continuously

---

## Configuration Guide

### Development (Local Redis)
```bash
REDIS_URL=redis://localhost:6379
NODE_ENV=development
REDLOCK_ENABLED=true
LOCK_TTL_MS=5000
```

### Development (No Redis)
```bash
NODE_ENV=development
REDLOCK_ENABLED=false
ALLOW_SINGLE_NODE=true
```

### Production (Managed Redis - AWS ElastiCache)
```bash
REDIS_URL=rediss://my-cluster.cache.amazonaws.com:6379
REDIS_TLS=true
REDIS_PASSWORD=secret
NODE_ENV=production
REDLOCK_ENABLED=true
LOCK_TTL_MS=5000
```

### Production (Redis Sentinel)
```bash
REDIS_MODE=sentinel
REDIS_SENTINELS=[{"host":"s1","port":26379},{"host":"s2","port":26379},{"host":"s3","port":26379}]
REDIS_MASTER_NAME=mymaster
REDIS_TLS=true
NODE_ENV=production
REDLOCK_ENABLED=true
LOCK_TTL_MS=5000
```

---

## Known Limitations

### Single Redis Client Issue
**Current State**: Redlock still uses only 1 Redis client in standalone mode.

**Why**: Redlock's quorum algorithm requires **independent** Redis instances. A single instance cannot provide true quorum.

**Workaround**: 
- Use `REDIS_MODE=sentinel` with at least 3 Sentinel nodes in production
- OR use `REDIS_MODE=cluster` with 3+ master nodes

**Future Work**: 
- Add support for multiple independent Redis URLs in standalone mode
- Example: `REDIS_URLS=redis://redis1:6379,redis://redis2:6379,redis://redis3:6379`

### Lock Contention
**Current State**: High-frequency operations (>10 req/s on same room) may still experience contention.

**Mitigation**:
- Rate limiting already in place (3-8 req/s per action)
- Increase `LOCK_TTL_MS` if operations are slow
- Use `REDLOCK_RETRY_COUNT` to allow more retries

---

## Rollback Plan

If issues arise after deployment:

1. **Disable Redlock**:
   ```bash
   REDLOCK_ENABLED=false
   ```
   Service will fall back to no-op locks (safe in single-instance deployments).

2. **Reduce TTL** (if locks are too long):
   ```bash
   LOCK_TTL_MS=3000
   ```

3. **Increase Retries** (if transient failures):
   ```bash
   REDLOCK_RETRY_COUNT=20
   REDLOCK_RETRY_DELAY=150
   ```

4. **Full Rollback**:
   ```bash
   git revert fix/redlock-quorum-and-ttl
   ```

---

## Commits in This Fix

1. `feat: Add configurable Redlock TTL and REDLOCK_ENABLED flag`
2. `feat: Enhance lock error logging with detailed diagnostics`
3. `feat: Add slow lock acquisition detection`
4. `docs: Update .env.example with Redlock configuration`
5. `docs: Add Redlock investigation and fix documentation`

---

## References

- [Redlock Algorithm](https://redis.io/docs/manual/patterns/distributed-locks/)
- [node-redis Redlock](https://github.com/mike-marcacci/node-redlock)
- Related: `PRODUCTION_CHECKLIST.md` Section 2 (Redlock)

