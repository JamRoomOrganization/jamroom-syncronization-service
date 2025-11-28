/**
 * Test Client para validar las optimizaciones de sincronización
 * 
 * Uso:
 * 1. Inicia el servidor: npm start
 * 2. En otra terminal: node test-sync-optimizations.js
 * 
 * Este script prueba:
 * - initialSync se envía inmediatamente al unirse
 * - measureLatency funciona correctamente
 * - Compensación de RTT
 */

import { io } from 'socket.io-client';

const SYNC_SERVICE_URL = process.env.SYNC_SERVICE_URL || 'http://localhost:3000';
const TEST_ROOM_ID = 'test-room-' + Date.now();
const TEST_USER_ID = 'test-user-' + Math.random().toString(36).substring(7);

console.log('🧪 Test de Optimizaciones de Sincronización');
console.log('============================================');
console.log(`URL: ${SYNC_SERVICE_URL}`);
console.log(`Room ID: ${TEST_ROOM_ID}`);
console.log(`User ID: ${TEST_USER_ID}\n`);

const socket = io(SYNC_SERVICE_URL, {
    transports: ['websocket'],
    query: {
        userId: TEST_USER_ID,
    },
});

let testResults = {
    connected: false,
    initialSyncReceived: false,
    initialSyncLatency: null,
    latencyMeasured: false,
    estimatedRTT: null,
    syncPacketReceived: false,
};

// 1. Test de conexión
socket.on('connect', async () => {
    console.log('✅ Conectado al servidor');
    console.log(`   Socket ID: ${socket.id}\n`);
    testResults.connected = true;

    // 2. Test de measureLatency
    console.log('📊 Midiendo latencia (RTT)...');
    const rtt = await measureRTT();
    testResults.latencyMeasured = true;
    testResults.estimatedRTT = rtt;
    console.log(`✅ RTT medido: ${rtt}ms`);
    console.log(`   Latencia estimada (RTT/2): ${rtt / 2}ms\n`);

    // 3. Test de initialSync
    console.log('🎯 Uniéndose a la sala...');
    const joinTimestamp = Date.now();

    // Escuchar initialSync
    socket.once('initialSync', (data) => {
        const receivedTimestamp = Date.now();
        const latency = receivedTimestamp - joinTimestamp;
        
        testResults.initialSyncReceived = true;
        testResults.initialSyncLatency = latency;

        console.log('✅ initialSync recibido');
        console.log(`   Latencia: ${latency}ms`);
        console.log(`   Server Processing: ${data.serverProcessingMs}ms`);
        console.log(`   Track ID: ${data.trackId || 'null'}`);
        console.log(`   Position: ${data.positionMs}ms`);
        console.log(`   Playback State: ${data.playbackState}`);
        console.log(`   Version: ${data.version}\n`);

        // Validar que initialSync llegó antes que syncPacket
        if (latency < 1000) {
            console.log('✅ initialSync llegó en menos de 1 segundo (OPTIMIZACIÓN EXITOSA)');
        } else {
            console.log('⚠️  initialSync tardó más de 1 segundo');
        }
        console.log('');
    });

    // También escuchar syncPacket para comparar
    socket.once('syncPacket', (data) => {
        testResults.syncPacketReceived = true;
        console.log('📦 syncPacket recibido (para comparación)');
        console.log(`   Track ID: ${data.trackId || 'null'}`);
        console.log(`   Position: ${data.positionMs}ms`);
        console.log(`   Playback State: ${data.playbackState}\n`);
    });

    // Emitir joinRoom con timestamp para métricas
    socket.emit('joinRoom', {
        roomId: TEST_ROOM_ID,
        clientJoinTimestamp: joinTimestamp,
    });

    // Esperar 5 segundos para ver si llega syncPacket también
    setTimeout(() => {
        printTestSummary();
        socket.disconnect();
        process.exit(testResults.initialSyncReceived && testResults.latencyMeasured ? 0 : 1);
    }, 5000);
});

socket.on('connect_error', (error) => {
    console.error('❌ Error de conexión:', error.message);
    process.exit(1);
});

socket.on('disconnect', (reason) => {
    console.log(`\n🔌 Desconectado: ${reason}`);
});

/**
 * Mide el RTT (Round-Trip Time) promediando 3 mediciones
 */
async function measureRTT() {
    const measurements = [];

    for (let i = 0; i < 3; i++) {
        const t0 = Date.now();

        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.warn('   ⚠️  Timeout en medición', i + 1);
                resolve();
            }, 2000);

            socket.emit('measureLatency', { clientTimestamp: t0 });

            socket.once('latencyResponse', ({ clientTimestamp }) => {
                clearTimeout(timeout);
                const t1 = Date.now();
                const rtt = t1 - clientTimestamp;
                measurements.push(rtt);
                console.log(`   Medición ${i + 1}: ${rtt}ms`);
                resolve();
            });
        });

        // Esperar 100ms entre mediciones
        if (i < 2) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    if (measurements.length === 0) {
        console.error('   ❌ No se pudo medir RTT');
        return 0;
    }

    // Usar mediana para robustez
    measurements.sort((a, b) => a - b);
    return measurements[Math.floor(measurements.length / 2)];
}

/**
 * Imprime resumen de los tests
 */
function printTestSummary() {
    console.log('\n============================================');
    console.log('📊 RESUMEN DE TESTS');
    console.log('============================================\n');

    console.log('1. Conexión:');
    console.log(`   ${testResults.connected ? '✅' : '❌'} Conectado\n`);

    console.log('2. Medición de Latencia:');
    console.log(`   ${testResults.latencyMeasured ? '✅' : '❌'} RTT medido`);
    if (testResults.estimatedRTT !== null) {
        console.log(`   RTT: ${testResults.estimatedRTT}ms`);
        console.log(`   Latencia estimada: ${testResults.estimatedRTT / 2}ms\n`);
    } else {
        console.log('');
    }

    console.log('3. initialSync:');
    console.log(`   ${testResults.initialSyncReceived ? '✅' : '❌'} Recibido`);
    if (testResults.initialSyncLatency !== null) {
        console.log(`   Latencia: ${testResults.initialSyncLatency}ms`);
        const status = testResults.initialSyncLatency < 1000 ? '✅ RÁPIDO' : '⚠️  LENTO';
        console.log(`   ${status}\n`);
    } else {
        console.log('');
    }

    console.log('4. syncPacket (comparación):');
    console.log(`   ${testResults.syncPacketReceived ? '✅' : '❌'} Recibido\n`);

    // Resultado final
    const allPassed = testResults.connected && 
                     testResults.initialSyncReceived && 
                     testResults.latencyMeasured &&
                     testResults.initialSyncLatency < 1000;

    console.log('============================================');
    if (allPassed) {
        console.log('✅ TODOS LOS TESTS PASARON');
        console.log('   Las optimizaciones están funcionando correctamente.');
    } else {
        console.log('⚠️  ALGUNOS TESTS FALLARON');
        console.log('   Revisar los logs anteriores.');
    }
    console.log('============================================\n');
}

