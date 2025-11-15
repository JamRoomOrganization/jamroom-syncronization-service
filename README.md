# jamroom-syncronization-service
Backend for synchronization service

## 🚀 Quick Start

### Development (Local Redis)

```bash
# 1. Install dependencies
npm install

# 2. Start Redis with Docker
docker-compose up -d redis

# 3. Configure environment (already set to local)
# File .env is configured for local development

# 4. Test Redis connection
npm run test:valkey

# 5. Start application
npm run dev
```

### Production (AWS ElastiCache Valkey)

```bash
# 1. Deploy to EC2 instance (same VPC as ElastiCache)
# 2. Install dependencies
npm install

# 3. Configure ElastiCache
cp .env.elasticache.example .env

# 4. Test connection
npm run test:valkey

# 5. Start application
npm start
```

## 📋 Configuration

### Local Development
The project is pre-configured for local development with Redis in Docker.

**File:** `.env` (current configuration)
```bash
REDIS_MODE=standalone
REDIS_URL=redis://localhost:6379
REDIS_TLS=false
```

### AWS ElastiCache Valkey
For production deployment with ElastiCache:

**File:** `.env.elasticache.example` (template)
```bash
REDIS_NODES=jamroom-sync-dev-001.jamroom-sync-dev.cnd9av.use1.cache.amazonaws.com:6379,jamroom-sync-dev-002.jamroom-sync-dev.cnd9av.use1.cache.amazonaws.com:6379,jamroom-sync-dev-003.jamroom-sync-dev.cnd9av.use1.cache.amazonaws.com:6379
REDIS_TLS=true
REDIS_CLUSTER_MODE=false
```

**Quick switch on Windows:**
```bash
switch-config.bat
```

## 🧪 Testing

### Test Redis/Valkey Connection
```bash
npm run test:valkey
```

Expected output (local):
```
✅ Redis initialization successful
[redis] initRedis done (mode: standalone, TLS: false, nodes: 1)
✅ All tests PASSED!
```

Expected output (ElastiCache from EC2):
```
✅ Redis initialization successful
[redis] Creating 3 Redlock clients for quorum
[redis] Redlock client 1/3 connected
[redis] Redlock client 2/3 connected
[redis] Redlock client 3/3 connected
[redis] initRedis done (mode: standalone, TLS: true, nodes: 3)
✅ All tests PASSED!
```

### Run Tests
```bash
npm test
```

## 📚 Documentation

- **[Integration Summary](INTEGRATION_SUMMARY.md)** - Complete integration details
- **[ElastiCache Configuration](HOTFIX_REDLOCK_CONFIG.md)** - Technical documentation
- **[Deployment Guide](DEPLOYMENT_GUIDE.md)** - Deployment instructions
- **[Validation Result](VALIDATION_RESULT.md)** - Current validation status

## 🔒 ElastiCache Integration

This project supports **Amazon ElastiCache Valkey** with:
- ✅ TLS encryption in transit
- ✅ Multi-node Redlock for distributed locks
- ✅ Automatic failover and high availability
- ✅ Backward compatibility with local development

**Note:** ElastiCache endpoints are only accessible from within AWS VPC.

## 🛠️ Available Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with nodemon
- `npm test` - Run test suite
- `npm run test:valkey` - Test Redis/Valkey connection
- `npm run test:redis` - Test legacy Redis connection

## 📞 Support

For issues or questions, check the documentation files or run the connection test:
```bash
npm run test:valkey
```

