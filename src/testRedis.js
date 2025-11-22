import { createClient } from 'redis';
import dotenv from 'dotenv';
dotenv.config();

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_PUBLIC_URL = process.env.REDIS_PUBLIC_URL;
const REDIS_TLS = process.env.REDIS_TLS === 'true';

console.log('🔍 Testing Redis Connection...');
console.log('REDIS_URL:', REDIS_URL.replace(/:[^:]*@/, ':****@'));
if (REDIS_PUBLIC_URL) {
    console.log('REDIS_PUBLIC_URL:', REDIS_PUBLIC_URL.replace(/:[^:]*@/, ':****@'));
}
console.log('REDIS_TLS:', REDIS_TLS);

const client = createClient({
    url: REDIS_URL,
    socket: {
        tls: REDIS_TLS,
        rejectUnauthorized: false
    }
});

client.on('error', (err) => console.error('❌ Redis error:', err.message));
client.on('connect', () => console.log('✅ Redis connecting...'));
client.on('ready', () => console.log('✅ Redis ready!'));

const run = async () => {
    try {
        await client.connect();
        console.log('✅ Connected to Redis');

        await client.set('test:key', 'hello jamroom');
        const value = await client.get('test:key');
        console.log('✅ Stored value:', value);

        await client.del('test:key');
        console.log('✅ Test key deleted');

        await client.disconnect();
        console.log('✅ Disconnected successfully');
    } catch (error) {
        console.error('❌ Error during test:', error.message);
        process.exit(1);
    }
};

run();
