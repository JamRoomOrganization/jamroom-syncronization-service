import { createClient } from 'redis';

const client = createClient({ url: 'redis://localhost:6379' });

client.on('error', (err) => console.error(' Redis error:', err));

const run = async () => {
    await client.connect();
    console.log('Connected to Redis');

    await client.set('test:key', 'hello jamroom');
    const value = await client.get('test:key');
    console.log(' Stored value:', value);

    await client.disconnect();
};

run();
