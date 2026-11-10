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

## When context is missing (Issue #5746)

A preset switch (`/agent use`) or session reset starts a fresh native session; context is not migrated. When a request uses referring expressions ("this article", "前面那篇", "那个文件"), plainly builds on an earlier conversation that is not in your context, or arrives as the first message of a fresh session, query this chat's history before doing anything else:

```bash
disclaude history query --chat <current Chat ID from the prompt metadata> --days 2 --limit 50
```

Fallback order: query history → if the referent or intent is still ambiguous, ask one short question listing the candidate referents found → do not make the user re-explain or re-send background the history already contains. If the query fails or returns nothing usable, say plainly which context is missing and ask the user to identify it; never fabricate the missing context.

Manually configured agents (outside disclaude's preset system) can reuse this pattern by copying this section into their own AGENTS.md or system prompt.

## Output schema

`--format json` (default) prints a single line `{"ok": true, ...result}` on stdout so callers can separate it from diagnostics:

```json
{
  "ok": true,
  "chatId": "oc_123",
  "days": [
    {
      "date": "2026-11-02",
      "path": "/srv/disclaude/workspace/chat/2026-11-02/oc_123.md",
      "messages": [
        { "direction": "incoming", "timestamp": "2026-11-02T09:00:00.000Z", "messageId": "om_1", "content": "用户消息原文" },
        { "direction": "outgoing", "timestamp": "2026-11-02T09:00:05.000Z", "messageId": "om_2", "content": "agent 回复" }
      ]
    }
  ],
  "totalMessages": 2,
  "truncatedByLimit": false
}
```

- `direction` is `incoming` (user, logged as `👤`) or `outgoing` (agent, logged as `🤖`).
- Days are newest-first; messages within a day are oldest-first.
- `ok: false` with a nonzero exit means the query itself failed (bad flags, unreadable config) — an absent chat is still `ok: true` with empty `days`.

`--format text` renders the same result for humans (day headers, `👤/🤖 [timestamp] (messageId)`, content), ending with a truncation note when `truncatedByLimit` is true.

The same query is available as `GET /api/history/query?chat=<id>&days=&limit=` on the running service's HTTP API (Bearer token required — conversation content is not a health check). Prefer the CLI; use the REST route only when a CLI is unavailable.

Local history covers what this machine recorded. When history is missing (another machine, rebuilt service), say so instead of treating an empty result as proof a conversation never happened; server-side fetch is a separate optional capability, not part of this skill.

Do not attempt writes through this service: it has no mutation surface, by design.
