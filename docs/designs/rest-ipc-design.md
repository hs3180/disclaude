# DisclaudeService HTTP API

The local HTTP API is the supported boundary between the service and its CLI,
managed tools, and local integrations. It replaces the removed Unix-socket
transport; there is no IPC transport selector or dual-path fallback.

```text
channel CLI / managed client
          │ HTTP
          ▼
DisclaudeService HTTP API ──► channel handlers and agent sessions
```

The API is intended for co-located clients. The service binds locally by
default. Keep it on a trusted interface; when an API token is configured, every
non-GET route requires a matching Bearer token. GET health/status routes remain
unauthenticated for probes, so the API should not be exposed to untrusted
networks. The service generates a fresh token for managed clients when needed;
see [environment variables](../environment-variables.md).

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Service status and version. |
| `GET` | `/api/ping` | Liveness probe. |
| `GET` | `/api/health/detailed` | Process and delivery diagnostics. |
| `GET` | `/api/temp-chats` | List tracked temporary chats. |
| `GET` | `/api/topic-stream` | Server-sent topic message events. |
| `POST` | `/api/push` | Push a message to an agent. |
| `POST` | `/api/send-message` | Send a channel text message. |
| `POST` | `/api/send-card` | Send a card payload. |
| `POST` | `/api/send-interactive` | Send a question/choice card. |
| `POST` | `/api/upload-file` | Upload a local file by path. |
| `POST` | `/api/upload-image` | Upload a local image by path. |
| `POST` | `/api/mark-chat-responded` | Record a temporary-chat response. |
| `POST` | `/api/private-workflows` | Run an authorized private workflow. |

File paths refer to files accessible to the service process; this local API does
not transfer file bytes using multipart requests. Clients should use the
channel CLI rather than constructing these requests directly where possible.

The HTTP API is implemented in `packages/service/src/http-api-server.ts`.
Channel CLI authentication and request construction live in
`packages/channel-cli/src/tools/channel-api-utils.ts`.
