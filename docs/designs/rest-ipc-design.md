# REST IPC Design Document

> Issue: #4168 — 用 REST API 取代 IPC 进行内部通信（MCP ↔ PrimaryNode）
> Sub-issue: #4279 — Phase 1+2 (endpoints + RestIpcClient)
> Version: Phase 1+2 complete
> Status: Implemented (pending review)
> Created: 2026-07-16

## 1. Overview

### 1.1 Goal

Replace the Unix-socket IPC between the MCP server and Primary Node with a REST API (HttpApiServer), enabling:
- Simpler deployment (no Unix socket lifecycle)
- Better observability (HTTP logging, health probes)
- Future cross-process support

### 1.2 Approach: phased migration

| Phase | Scope | Issue | Status |
|-------|-------|-------|--------|
| Phase 1 | 7 REST endpoints (channel-method parity) | #4279 | ✅ Complete (#4341, #4343–#4348) |
| Phase 2 | RestIpcClient + getIpcClient wiring | #4279 | ✅ Complete (#4349) |
| Phase 3 | Remove Unix-socket IPC | #4280 | ⬜ Future |
| Phase 4 | Migration acceptance (safety review + full integration) | #4281 | ⬜ Future |

Dual-path retention: IPC stays as default (Phase 3 removes it). REST is opt-in via env var.

## 2. Architecture

```
MCP Server (mcp-server)
  ↓ getIpcClient()
  ↓ DISCLAUDE_REST_IPC_ENABLED=true?
  ├─ YES → RestIpcClient (HTTP fetch)
  │         ↓
  │    HttpApiServer (primary-node, localhost)
  │         ↓ route handler
  │    primaryNode.{sendMessage|sendCard|...}()
  │         ↓ resolveApiHandlers(chatId)
  │    Channel handler (Feishu/WeChat/REST)
  │
  └─ NO (default) → UnixSocketIpcClient (existing)
```

## 3. Phase 1: REST Endpoints

### 3.1 Endpoint table

| Method | Path | IPC method | PR |
|--------|------|------------|-----|
| GET | `/api/ping` | ping | #4341 |
| POST | `/api/send-message` | sendMessage | #4343 |
| POST | `/api/send-card` | sendCard | #4344 |
| POST | `/api/send-interactive` | sendInteractive | #4345 |
| POST | `/api/upload-file` | uploadFile | #4346 |
| POST | `/api/upload-image` | uploadImage | #4347 |
| GET | `/api/temp-chats` | listTempChats | #4348 |

> ⚠️ `markChatResponded` was descoped — #4342 was closed as **won't-implement** (the IPC method has 0 in-tree callers and the `responded` flag it writes is never read). There is no `/api/mark-chat-responded` route on `main`; the client route-map entry is documented inert in `rest-ipc-client.ts:78`. Phase 1 ships **7** active endpoints.

### 3.2 Design decisions

- **filePath vs multipart** (uploads): Used filePath because the REST face is localhost-bound (co-located). Exact IPC parity, no multipart overhead. Documented in #4346/#4347.
- **single-process semantics** (listTempChats): Current architecture is single-process, so cross-process aggregation is a future concern. Documented in #4348.
- **Auth**: POST routes require Bearer token (`apiToken`). GET routes are token-exempt (like `/api/status`).

### 3.3 Response envelope

All endpoints return `{ ok: true, ...IPC_PAYLOAD }`. The `ok` envelope is stripped by RestIpcClient.

## 4. Phase 2: RestIpcClient + Wiring

### 4.1 RestIpcClient (`packages/core/src/ipc/rest-ipc-client.ts`)

- `implements IpcClientLike` — true drop-in for `UnixSocketIpcClient`.
- Table-driven routing: 12 IPC methods → REST endpoints.
- Per-route response shaping (`Route.shape`):
  - Channel methods: default `stripOk`.
  - `pushToAgent` → `/api/push`: `{ ok, message }` → `{ success: ok }`.
  - `loopStart/loopStop/loopStatus` → `/api/loop/*`: per-method shape adaptation.
- Dynamic path builder (`Route.pathBuilder`): for `loopStatus` (`/api/loop/status/:loopId`).
- `isAvailable()`: GET `/api/ping` health probe.
- `disconnect()`: no-op (stateless HTTP), matching `UnixSocketIpcClient.disconnect()` signature.
- 15 tests (mocked fetch).

### 4.2 getIpcClient wiring (`packages/core/src/ipc/ipc-utils.ts`)

```ts
if (process.env.DISCLAUDE_REST_IPC_ENABLED === 'true') {
  ipcClientInstance = new RestIpcClient({ baseUrl, apiToken });
} else {
  ipcClientInstance = new UnixSocketIpcClient({ socketPath }); // default
}
```

### 4.3 Environment variables (decision 3: env injection)

| Env var | Required | Default | Description |
|---------|----------|---------|-------------|
| `DISCLAUDE_REST_IPC_ENABLED` | No | unset (IPC) | Set to `'true'` to enable REST IPC. |
| `DISCLAUDE_REST_IPC_BASE_URL` | No | `http://localhost:9200` | HttpApiServer URL. |
| `DISCLAUDE_REST_IPC_API_TOKEN` | No | unset | Bearer token for POST endpoints. |

## 5. Remaining Work

- **Phase 3 (#4280)**: Remove Unix-socket IPC + consolidate LoopRunner dual-path. Only after Phase 1+2 are production-tested with REST enabled.
- **Phase 4 (#4281)**: Migration acceptance — safety review + full integration of REST IPC. Latency baseline monitoring was **removed** from #4281 (#4351 closed: REST IPC is an architectural migration, not a perf optimization; the ~51× same-machine latency regression was measured in #4275 and already accepted in #4281, so continuous runtime instrumentation + drift alerting would add log noise with no action consumer).

## 6. PR Index

| PR | Title |
|----|-------|
| #4341 | GET /api/ping |
| #4342 | POST /api/mark-chat-responded — ❌ closed (won't-implement: 0 callers, flag unread) |
| #4343 | POST /api/send-message |
| #4344 | POST /api/send-card |
| #4345 | POST /api/send-interactive |
| #4346 | POST /api/upload-file (filePath) |
| #4347 | POST /api/upload-image (filePath) |
| #4348 | GET /api/temp-chats (single-process) |
| #4349 | RestIpcClient (12 methods + IpcClientLike + wiring) |
| #4351 | pushToAgent latency baseline monitoring — ❌ closed (descoped from #4281) |
