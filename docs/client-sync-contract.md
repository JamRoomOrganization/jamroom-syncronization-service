# Client Sync Contract

## 1. Join flow
- Establecer la conexión Socket.IO usando `io(url, { auth: { userId } })`.
- Emitir `joinRoom` con `{ roomId }` (y opcionalmente `userId` si cambió).
- Solicitar `GET /v1/rooms/:roomId/state`.
- Con la respuesta:
  - Realizar *seek* local a `effectivePositionMs`.
  - Guardar `serverTimeMs` para estimar el desfase reloj cliente-servidor.
  - Si `playbackState === "playing"`, iniciar reproducción de inmediato.

## 2. Realtime events from server
- `play`
  - Campos: `roomId`, `trackId`, `startAtServerTimeMs`, `startPositionMs`, `version`.
  - Acción: asegurar que el audio local corresponde al track, hacer *seek* si cambió y reproducir.
- `pause`
  - Campos: `roomId`, `positionMs`, `serverTimeMs`, `version`.
  - Acción: pausar y alinear `currentTime` local.
- `seek`
  - Campos: `roomId`, `positionMs`, `serverTimeMs`, `version`.
  - Acción: realizar *hard seek* inmediato.
- `syncPacket` (1 Hz)
  - Campos: `roomId`, `serverTimeMs`, `playbackState`, `positionMs`, `trackId`, `version`.
  - Acción:
    - Calcular *drift* vs. la posición local.
    - Si `|drift| < ~60 ms` → ignorar.
    - Si `|drift|` entre ~60 ms y ~150 ms → enviar `driftReport`, sin *hard seek*.
    - Si `|drift| > ~150 ms` → preparar ajuste brusco.
- `rateAdjust` (unicast)
  - Campos: `playbackRate`, `durationMs`, `reason`.
  - Acción: aplicar temporalmente el `playbackRate` indicado.
- `heartbeatAck`
  - Campos: `roomId`, `serverTimeMs`.
  - Acción: mantener actualizado el offset de reloj.

## 3. Reporting back to server
- Enviar `heartbeat` periódicamente con `{ roomId, clientTimeMs }`.
- Enviar `driftReport` con `{ roomId, clientTimeMs, localPositionMs, observedServerTimeMs, observedServerPositionMs }`.

## 4. Audius playback
- Obtener la URL del stream desde `GET https://discoveryprovider.audius.co/v1/tracks/:track_id/stream`.
- Usar peticiones `Range` para realizar *seek* en el stream.
- El Sync Service no entrega audio; únicamente indica la posición y estado que el reproductor debe alcanzar.
