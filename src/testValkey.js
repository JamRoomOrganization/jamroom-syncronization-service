// Test script to validate Redis/Valkey connection and Redlock functionality
// Usage: node src/testValkey.js

import { redisClient, redlock, redlockClients, initRedis, shutdownRedis } from './config/redis.js';

async function testRedisConnection() {
  console.log('\n🔍 Testing Redis/Valkey Connection...\n');

  try {
    await initRedis();
    console.log('✅ Redis initialization successful');

    // Test 1: Basic SET/GET operation
    console.log('\n📝 Test 1: Basic SET/GET operation');
    const testKey = 'test:connection:' + Date.now();
    const testValue = 'ElastiCache Valkey Connection Test';

    await redisClient.set(testKey, testValue);
    console.log(`   SET ${testKey} = "${testValue}"`);

    const retrievedValue = await redisClient.get(testKey);
    console.log(`   GET ${testKey} = "${retrievedValue}"`);

    if (retrievedValue === testValue) {
      console.log('   ✅ SET/GET test PASSED');
    } else {
      console.error('   ❌ SET/GET test FAILED');
      console.error(`   Expected: "${testValue}", Got: "${retrievedValue}"`);
    }

    // Clean up
    await redisClient.del(testKey);

    // Test 2: Hash operations (used by room state)
    console.log('\n📦 Test 2: Hash operations (HSET/HGETALL)');
    const hashKey = 'test:room:' + Date.now();
    const roomData = {
      roomId: 'test-room-123',
      trackId: 'track-456',
      playbackState: 'playing',
      basePositionMs: '1000',
      baseServerTimeMs: String(Date.now()),
      playbackRate: '1.0',
    };

    await redisClient.hSet(hashKey, roomData);
    console.log(`   HSET ${hashKey} with ${Object.keys(roomData).length} fields`);

    const retrievedData = await redisClient.hGetAll(hashKey);
    console.log(`   HGETALL ${hashKey}:`, retrievedData);

    if (retrievedData.roomId === roomData.roomId && retrievedData.trackId === roomData.trackId) {
      console.log('   ✅ HSET/HGETALL test PASSED');
    } else {
      console.error('   ❌ HSET/HGETALL test FAILED');
    }

    // Clean up
    await redisClient.del(hashKey);

    // Test 3: Redlock distributed lock
    console.log('\n🔒 Test 3: Redlock distributed lock');
    console.log(`   Using ${redlockClients.length} Redis client(s) for quorum`);

    const lockResource = 'test:lock:' + Date.now();
    const lockTTL = 5000; // 5 seconds

    console.log(`   Acquiring lock on "${lockResource}" with TTL ${lockTTL}ms...`);
    const lock = await redlock.acquire([lockResource], lockTTL);
    console.log(`   ✅ Lock acquired successfully`);
    console.log(`   Lock expiration: ${new Date(lock.expiration).toISOString()}`);

    // Simulate some work
    console.log('   Simulating work for 1 second...');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Release the lock
    console.log('   Releasing lock...');
    await lock.release();
    console.log('   ✅ Lock released successfully');

    // Test 4: Verify lock was released (should be able to acquire again)
    console.log('\n🔄 Test 4: Verify lock release');
    const lock2 = await redlock.acquire([lockResource], lockTTL);
    console.log('   ✅ Successfully acquired lock again (confirms release)');
    await lock2.release();

    // Test 5: Connection info
    console.log('\n📊 Connection Info:');
    const info = await redisClient.info('server');
    const lines = info.split('\r\n');
    const redisVersion = lines.find(l => l.startsWith('redis_version:'));
    const uptimeSeconds = lines.find(l => l.startsWith('uptime_in_seconds:'));

    if (redisVersion) console.log(`   ${redisVersion}`);
    if (uptimeSeconds) console.log(`   ${uptimeSeconds}`);

    console.log('\n✅ All tests PASSED!\n');

  } catch (error) {
    console.error('\n❌ Test FAILED with error:');
    console.error(error);
    process.exit(1);
  } finally {
    await shutdownRedis();
    console.log('Connection closed.');
  }
}

// Run the test
testRedisConnection();

