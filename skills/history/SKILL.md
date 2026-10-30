---
name: history
description: Read conversation history for a chat through the disclaude history query service. Use when the task needs past messages, prior decisions, or what was already said in this or another chat. Read-only and structured; not for sending anything.
---

# Session history query

Agents read conversation history through the disclaude history query service, not injected tools or private read paths (Issue #5603). The service is read-only and returns structured JSON covering locally available history.

Use the CLI supplied by the runtime:

```bash
disclaude history query --chat <chatId> [--days N] [--limit N] [--format json|text]
```

- `--chat` is required. Use the current chat's identifier from the request context; for another chat, use its exact id, never a guess.
- `--days` bounds the lookback (default: `sessionRestore.historyDays`, 7). `--limit` keeps only the newest N messages across days and reports `truncatedByLimit: true` when it dropped older ones.
- The result lists days newest-first with per-day absolute `path` and parsed messages (`direction`, `timestamp`, `messageId`, `content`). When a truncated day matters, read that day file directly instead of raising the limit blindly.
- A chat with no local history returns an empty result (`days: []`), not an error.

The same query is available as `GET /api/history/query?chat=<id>&days=&limit=` on the running service's HTTP API (Bearer token required — conversation content is not a health check). Prefer the CLI; use the REST route only when a CLI is unavailable.

Local history covers what this machine recorded. When history is missing (another machine, rebuilt service), say so instead of treating an empty result as proof a conversation never happened; server-side fetch is a separate optional capability, not part of this skill.

Do not attempt writes through this service: it has no mutation surface, by design.
