# jamroom-syncronization-service

Servicio backend de sincronización en tiempo real para salas de escucha en JamRoom.

Coordina estado de reproducción (play/pause/seek/changeTrack), publica eventos por Socket.IO y Redis Pub/Sub, y opcionalmente integra sesiones de voz (chatVoice-service + LiveKit).

## Tabla de contenidos

- [1. Propósito y alcance](#1-proposito-y-alcance)
- [2. Arquitectura de alto nivel](#2-arquitectura-de-alto-nivel)
- [3. Requisitos previos](#3-requisitos-previos)
- [4. Instalación](#4-instalacion)
- [5. Configuración de entorno (`.env`)](#5-configuracion-de-entorno-env)
- [6. Redis local vs Valkey/ElastiCache](#6-redis-local-vs-valkeyelasticache)
- [7. Ejecución](#7-ejecucion)
- [8. Scripts disponibles](#8-scripts-disponibles)
- [9. API HTTP principal](#9-api-http-principal)
- [10. Eventos Socket.IO principales](#10-eventos-socketio-principales)
- [11. Pruebas y calidad](#11-pruebas-y-calidad)
- [12. Despliegue en Railway](#12-despliegue-en-railway)
- [13. Estructura relevante del proyecto](#13-estructura-relevante-del-proyecto)
- [14. Observabilidad y troubleshooting](#14-observabilidad-y-troubleshooting)
- [15. Seguridad y manejo de secretos](#15-seguridad-y-manejo-de-secretos)
- [16. Soporte](#16-soporte)

## 1. Propósito y alcance

Este servicio:

- Mantiene estado de reproducción por sala en Redis.
- Aplica operaciones de control (`play`, `pause`, `seek`, `changeTrack`) con control de versión.
- Difunde sincronización a clientes vía Socket.IO.
- Usa Pub/Sub para coordinar múltiples instancias.
- Integra autorización de control de sala contra `queue-service`.
- Soporta integración de voz opcional (feature flags `JAMROOM_ENABLE_VOICE` / `JAMROOM_ENABLE_VOICE_MEDIA`).

## 2. Arquitectura de alto nivel

1. `src/server.js` levanta Express + Socket.IO.
2. `src/config/redis.js` inicializa `redisClient`, `pubClient` y `subClient`.
3. `src/controllers/syncController.js` expone endpoints HTTP de estado/control.
4. `src/sockets/syncGateway.js` maneja eventos de tiempo real.
5. `src/services/syncDomainService.js` aplica lógica de dominio y publica eventos.
6. `src/services/redisService.js` persiste estado/versiones/host en Redis.
7. `src/services/authService.js` valida permisos contra `queueMembershipClient`.

## 3. Requisitos previos

- Node.js 18+ (CI usa Node 18).
- npm.
- Redis/Valkey accesible desde el entorno de ejecución.

## 4. Instalación

```bash
npm install
```

## 5. Configuración de entorno (`.env`)

> No existe un `.env.example` versionado actualmente. Crea tu `.env` manualmente en la raíz del proyecto.

### 5.1 Variables base

| Variable | Requerida | Default en código | Ejemplo | Uso |
|---|---|---|---|---|
| `PORT` | No | `3001` | `3001` | Puerto HTTP |
| `CORS_ORIGIN` | No | `*` | `http://localhost:3000` | Orígenes permitidos (coma-separados) |
| `NODE_ENV` | No | — | `development` / `production` | Ajustes de entorno |
| `AUTH_BYPASS` | No | `false` | `false` | Saltar validación de permisos (solo dev/controlado) |
| `LOG_LEVEL` | No | `info` | `debug` | Verbosidad de logs |
| `ENABLE_PREBUFFER` | No | `false` | `true` | Control de prebuffer en gateway |
| `ALLOW_SINGLE_NODE` | No | `false` | `true` | Permite degradación cuando falla adapter Redis |
| `SYNC_INTERVAL_MS` | No | `1000` | `500` | Intervalo de emisión de `syncPacket` |
| `QUEUE_SERVICE_URL` | No | `https://jamroom-queue-service-production.up.railway.app` | `http://localhost:3000` | Base URL de `queue-service` |

### 5.2 Variables Redis / Valkey / locking

| Variable | Requerida | Default en código | Ejemplo |
|---|---|---|---|
| `REDIS_MODE` | No | `standalone` | `standalone`, `nodes`, `cluster`, `sentinel` |
| `REDIS_URL` | Condicional | — | `redis://localhost:6379` |
| `REDIS_HOST` | No | `127.0.0.1` | `127.0.0.1` |
| `REDIS_PORT` | No | `6379` | `6379` |
| `REDIS_PASSWORD` | No | — | `***` |
| `REDIS_TLS` | No | `false` | `true` |
| `REDIS_NODES` | Condicional | — | `host1:6379,host2:6379,host3:6379` |
| `REDIS_CLUSTER_MODE` | No | `false` | `true` |
| `REDIS_SENTINELS` | Condicional | — | `[{"host":"s1","port":26379}]` |
| `REDIS_MASTER_NAME` | No | `mymaster` | `mymaster` |
| `REDIS_CLUSTER_NODES` | Condicional | — | `[{"host":"c1","port":6379}]` |
| `REDLOCK_ENABLED` | No | `true` | `false` |
| `LOCK_TTL_MS` | No | `5000` | `5000` |
| `REDLOCK_RETRY_COUNT` | No | `10` | `10` |
| `REDLOCK_RETRY_DELAY` | No | `200` | `200` |
| `REDLOCK_RETRY_JITTER` | No | `200` | `200` |
| `RAILWAY_REDIS_URL` / `REDIS_PUBLIC_URL` | No | — | `redis://...` |
| `RAILWAY_REDIS_HOST` / `RAILWAY_REDIS_PORT` / `RAILWAY_REDIS_PASSWORD` | No | — | `...` |

### 5.3 Variables de voz (opcionales)

| Variable | Requerida | Default en código | Ejemplo |
|---|---|---|---|
| `JAMROOM_ENABLE_VOICE` | No | `false` | `true` |
| `JAMROOM_ENABLE_VOICE_MEDIA` | No | `false` | `true` |
| `VOICE_SERVICE_BASE_URL` | Sí (si voz habilitada) | — | `http://localhost:3002` |
| `VOICE_SERVICE_TIMEOUT_MS` | No | `4000` | `3000` |
| `INTERNAL_API_KEY` | Recomendado | — | `***` |
| `LIVEKIT_API_KEY` | Recomendado | — | `***` |
| `LIVEKIT_API_SECRET` | Recomendado | — | `***` |
| `LIVEKIT_WS_URL` | Recomendado | — | `wss://...` |
| `LIVEKIT_TOKEN_TTL_SECONDS` | No | `3600` | `3600` |

## 6. Redis local vs Valkey/ElastiCache

### Redis local (desarrollo)

Modo recomendado para desarrollo rápido:

```env
REDIS_MODE=standalone
REDIS_URL=redis://127.0.0.1:6379
REDIS_TLS=false
```

También puedes usar `REDIS_HOST` + `REDIS_PORT` si no usas `REDIS_URL`.

### Valkey/ElastiCache (AWS)

Caso común en AWS (múltiples nodos + TLS):

```env
REDIS_MODE=nodes
REDIS_NODES=cache-001:6379,cache-002:6379,cache-003:6379
REDIS_TLS=true
REDIS_CLUSTER_MODE=false
```

Notas importantes:

- `REDIS_NODES` habilita conexiones multi-nodo para Redlock (quorum) cuando `REDIS_CLUSTER_MODE=false`.
- Si usas cluster real, define `REDIS_MODE=cluster` o `REDIS_CLUSTER_MODE=true`.
- Si usas sentinel, define `REDIS_MODE=sentinel` y `REDIS_SENTINELS`.
- Endpoints privados de ElastiCache normalmente sólo son accesibles dentro de la VPC.
- El nombre correcto de variable es **`REDIS_MODE`** (no `REDISMODE`).

## 7. Ejecución

### Desarrollo

```bash
npm run dev
```

Opciones relacionadas:

- `npm run dev:local` (usa `dotenv_config_path=.env.local`)
- `npm run dev:railway`

### Producción

```bash
npm start
```

## 8. Scripts disponibles

| Script | Comando | Descripción |
|---|---|---|
| `start` | `node src/server.js` | Ejecuta el servicio en modo normal |
| `dev` | `nodemon --exec "node -r dotenv/config src/server.js"` | Desarrollo con recarga |
| `dev:local` | `nodemon --exec "node -r dotenv/config src/server.js dotenv_config_path=.env.local"` | Desarrollo usando `.env.local` |
| `dev:railway` | `nodemon src/server.js` | Desarrollo orientado a entorno Railway |
| `test` | `jest` (VM modules) | Suite de pruebas |
| `test:watch` | `jest --watch` | Pruebas en modo watch |
| `test:coverage` | `jest --coverage` | Cobertura local |
| `test:ci` | `jest --coverage --forceExit --detectOpenHandles` | Pruebas usadas por CI |
| `test:verbose` | `jest --verbose` | Salida detallada |
| `test:single` | `jest --testPathPattern=` | Ejecutar un archivo/patrón |
| `setup:railway` | `node scripts/setup-railway.js` | Carga variables de `.env` a Railway CLI |
| `railway:logs` | `railway logs` | Ver logs en Railway |
| `railway:vars` | `railway variables` | Ver variables en Railway |

## 9. API HTTP principal

Endpoints relevantes (`src/controllers/syncController.js` y `src/server.js`):

- `GET /health`
- `GET /__health`
- `GET /v1/rooms/:roomId/state`
- `POST /v1/rooms/:roomId/play`
- `POST /v1/rooms/:roomId/pause`
- `POST /v1/rooms/:roomId/seek`
- `POST /v1/rooms/:roomId/track`
- `GET /v1/tracks/:trackId/streamUrl`
- `GET /debug/state/:roomId`

## 10. Eventos Socket.IO principales

Eventos de cliente soportados en `src/sockets/syncGateway.js`:

- `joinRoom`, `leaveRoom`
- `heartbeat`, `measureLatency`, `driftReport`
- `fastCommand`
- `play`, `pause`, `seek`, `changeTrack`
- Voz (si habilitada): `voice:join`, `voice:leave`, `voice:mute` y otros eventos `voice:*`

Eventos emitidos por servidor (según flujo):

- `initialSync`, `fastSync`, `syncPacket`, `controlAck`, `controlError`
- `roomUserJoin`, `roomUserLeave`
- `voice:state`, `voice:session`, `voice:error`

## 11. Pruebas y calidad

### Ejecutar pruebas

```bash
npm test
```

Cobertura:

```bash
npm run test:coverage
```

### CI

Workflow: `.github/workflows/ci.yml`

- Instala dependencias (`npm ci`)
- Ejecuta `npm run test:ci`
- Ejecuta análisis SonarCloud (`sonar-project.properties`)

## 12. Despliegue en Railway

Configuración base en `railway.json`:

- Builder: `NIXPACKS`
- Start command: `npm start`
- Restart policy: `ON_FAILURE` con `restartPolicyMaxRetries: 10`

Script útil:

```bash
npm run setup:railway
```

Este script:

- valida Railway CLI,
- lee variables desde `.env`,
- y ejecuta `railway variables set ...`.

## 13. Estructura relevante del proyecto

```text
src/
  config/                 # Redis + configuración de voz
  controllers/            # Endpoints HTTP
  services/               # Dominio, Redis, auth, integraciones externas
  sockets/                # Gateway Socket.IO
  voice/                  # Estado y errores de voz
  utils/                  # Métricas, logging, retry, rate limit, etc.
  server.js               # Punto de entrada
.github/workflows/ci.yml  # Pipeline CI
scripts/setup-railway.js  # Helper de variables Railway
```

## 14. Observabilidad y troubleshooting

- Health checks: `GET /health` y `GET /__health`.
- Logs de bootstrap reportan estado de variables críticas (sin imprimir secretos completos).
- Si falla Redis al iniciar, el proceso termina con `Fatal startup error`.
- Si ves errores de quorum de Redlock, revisa conectividad y nodos en `REDIS_NODES`.
- Si la voz está habilitada y `VOICE_SERVICE_BASE_URL` falta, los eventos de voz se degradan con `voice:error`.

## 15. Seguridad y manejo de secretos

- **No** subas `.env` ni credenciales al repositorio.
- Usa secretos en CI/CD (`GitHub Actions secrets`, variables de Railway, etc.).
- Trata como sensibles: `INTERNAL_API_KEY`, `LIVEKIT_API_SECRET`, contraseñas Redis y URLs privadas de AWS.
- Evita exponer endpoints internos de ElastiCache fuera de red privada/VPC.

## 16. Soporte

- Reporta incidencias en: <https://github.com/JamRoomOrganization/jamroom-syncronization-service/issues>
- Para depuración rápida, inicia por:
  - `npm test`
  - `GET /health`
  - revisión de variables de entorno efectivas del despliegue
