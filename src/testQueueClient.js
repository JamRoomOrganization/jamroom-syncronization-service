/**
 * Script de prueba para verificar la conexión con el queue-service
 * usando el nuevo cliente centralizado.
 *
 * Uso: node src/testQueueClient.js
 */

import queueClient from './lib/queueClient.js';
import dotenv from 'dotenv';

dotenv.config();

async function testQueueServiceConnection() {
  console.log('\n🧪 Probando conexión con Queue Service...\n');
  console.log('📋 Configuración:');
  console.log('   QUEUE_SERVICE_URL:', process.env.QUEUE_SERVICE_URL);
  console.log('');

  // ✅ Test 1: Health check (ruta correcta: /health sin /api)
  console.log('1️⃣ Test: Health Check');
  try {
    const response = await queueClient.get('/health');
    const data = await response.json();

    console.log('   ✅ Queue-service está disponible!');
    console.log('   📦 Respuesta:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('   ❌ Health check falló:', error.message);
    if (error.responseData) {
      console.error('   📦 Body:', error.responseData);
    }
  }

  // ✅ Test 2: Endpoint protegido (debe devolver 401)
  console.log('\n2️⃣ Test: Endpoint Protegido (debe devolver 401)');
  try {
    await queueClient.get('/api/rooms/test123/queue');
    console.log('   ⚠️  Endpoint no requiere autenticación (inesperado)');
  } catch (error) {
    if (error.statusCode === 401) {
      console.log('   ✅ Correctamente requiere autenticación (401)');
    } else {
      console.error('   ❌ Error inesperado:', error.message, `(${error.statusCode})`);
      if (error.responseData) {
        console.error('   📦 Body:', error.responseData);
      }
    }
  }

  // ✅ Test 3: Verificar normalización de paths
  console.log('\n3️⃣ Test: Normalización de Paths');

  const testCases = [
    { input: '//api//rooms//123', expected: '/api/rooms/123' },
    { input: 'api/rooms/123', expected: '/api/rooms/123' },
    { input: '/api/rooms/123/', expected: '/api/rooms/123/' },
  ];

  for (const { input, expected } of testCases) {
    const normalized = queueClient._normalizePath(input);
    const match = normalized === expected ? '✅' : '❌';
    console.log(`   ${match} Input: "${input}" → Output: "${normalized}" (Expected: "${expected}")`);
  }

  console.log('\n✅ Tests completados!\n');
  console.log('📝 Próximos pasos:');
  console.log('   1. Verificar que QUEUE_SERVICE_URL apunte a Railway:');
  console.log('      https://jamroom-queue-service-production.up.railway.app');
  console.log('   2. Verificar logs del sync-service con:');
  console.log('      railway logs --service=jamroom-sync-service');
  console.log('   3. Buscar líneas tipo:');
  console.log('      [queueClient] Initialized with baseUrl: https://...');
  console.log('      [queueClient] GET /health');
  console.log('');

  process.exit(0);
}

testQueueServiceConnection().catch((error) => {
  console.error('\n❌ Test falló con error fatal:', error);
  process.exit(1);
});

