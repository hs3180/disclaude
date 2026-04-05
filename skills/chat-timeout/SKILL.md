---
name: chat-timeout
description: Detect timed-out active chats, dissolve groups via lark-cli, update status to expired, and clean up stale expired files. Primarily invoked by the companion chats-cleanup Schedule. Use when user says keywords like "聊天超时", "群组解散", "chat timeout", "会话过期", "清理过期", "/chat-timeout check", "/chat-timeout cleanup". Also supports direct invocation for manual checks.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Chat Timeout

Detect timed-out active chats, dissolve their groups, and clean up stale expired files.

This skill handles the **end-of-life** for temporary chats created by the `chat` skill. It works in two modes:

1. **Timeout Detection** — Find active chats where `now >= expiresAt`, dissolve the group, mark as expired
2. **Cleanup** — Remove expired chat files that have passed the retention period

## Single Responsibility

- ✅ Detect timed-out active chats (`now >= expiresAt`)
- ✅ Dissolve groups via `lark-cli` (`DELETE /open-apis/im/v1/chats/{chatId}`)
- ✅ Update chat status to `expired` with `expiredAt` timestamp
- ✅ Clean up expired files past retention period
- ❌ DO NOT create or activate chats (handled by `chat` skill + `chats-activation` schedule)
- ❌ DO NOT send messages to groups (handled by consumer skills)
- ❌ DO NOT handle user responses (handled by `chat` skill)

## Invocation Modes

### Mode 1: Schedule Invocation (Primary)

Called automatically by the `chats-cleanup` Schedule:

```
Schedule → calls this Skill → dissolves expired groups + cleans up stale files
```

### Mode 2: Direct User Invocation

```
/chat-timeout check   — Check for timed-out active chats (dry-run)
/chat-timeout run     — Process timed-out chats (dissolve + expire)
/chat-timeout cleanup — Clean up expired files past retention
```

## Prerequisites

- `lark-cli` (Lark Suite official CLI, npm global install: `npm install -g @larksuite/cli`)
- `jq` (JSON processing)
- Node.js scripts in `scripts/chat-timeout/` (TypeScript, run via `npx tsx`)

## Execution Flow

### Timeout Detection (`scripts/chat-timeout/timeout.ts`)

```bash
CHAT_MAX_PER_RUN=10 npx tsx scripts/chat-timeout/timeout.ts
CHAT_DRY_RUN=true npx tsx scripts/chat-timeout/timeout.ts   # dry-run mode
```

```
Step 0: Environment check (lark-cli, jq available)
Step 1: Scan workspace/chats/ for active chats
Step 2: For each active chat:
  ├─ Check if now >= expiresAt (UTC Z-suffix format)
  ├─ If expired:
  │   ├─ Check if user has responded (response field)
  │   ├─ If no response → dissolve group via lark-cli
  │   ├─ Update status to expired with expiredAt timestamp
  │   └─ Report result
Step 3: Summary (processed / skipped / errors)
```

### Cleanup (`scripts/chat-timeout/cleanup.ts`)

```bash
CHAT_RETENTION_HOURS=1 npx tsx scripts/chat-timeout/cleanup.ts
CHAT_DRY_RUN=true npx tsx scripts/chat-timeout/cleanup.ts   # dry-run mode
```

```
Step 0: Environment check
Step 1: Scan workspace/chats/ for expired chats
Step 2: For each expired chat:
  ├─ Check if expiredAt is past retention period (default: 1 hour)
  ├─ If past retention:
  │   ├─ Delete chat file
  │   ├─ Delete .lock file (if exists)
  │   └─ Report result
Step 3: Summary (cleaned / retained / errors)
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CHAT_MAX_PER_RUN` | No | `10` | Max chats to process per execution |
| `CHAT_RETENTION_HOURS` | No | `1` | Hours to retain expired files before cleanup |
| `CHAT_DRY_RUN` | No | `false` | If `true`, report actions without executing them |
| `LARK_TIMEOUT_MS` | No | `30000` | Timeout for lark-cli API calls (ms) |

## Chat File Format

Uses the same format as the `chat` skill. The key fields for timeout:

```json
{
  "id": "pr-123",
  "status": "active",
  "chatId": "oc_xxx",
  "expiresAt": "2026-03-25T10:00:00Z",
  "response": null,
  "expiredAt": null
}
```

After timeout processing:

```json
{
  "id": "pr-123",
  "status": "expired",
  "chatId": "oc_xxx",
  "expiresAt": "2026-03-25T10:00:00Z",
  "response": null,
  "expiredAt": "2026-03-25T10:05:00Z"
}
```

## Timeout Logic

| Condition | Action |
|-----------|--------|
| `status=active` AND `now >= expiresAt` AND `response=null` | Dissolve group + mark expired |
| `status=active` AND `now >= expiresAt` AND `response!=null` | Mark expired (don't dissolve — user already responded) |
| `status=active` AND `expiresAt` non-UTC format | Skip (fail-open, log warning) |
| `status=expired` AND `now - expiredAt > retention` | Delete file + lock |
| `status=expired` AND `now - expiredAt <= retention` | Keep file (within retention window) |
| `status=pending` OR `status=failed` | Skip (not this skill's responsibility) |

## Error Handling

| Scenario | Action |
|----------|--------|
| `lark-cli` not available | Fatal error, exit immediately |
| Group dissolution fails (API error) | Log error, still mark as expired (group may already be deleted) |
| Group dissolution times out | Log warning, still mark as expired |
| Chat file corrupted (invalid JSON) | Log warning, skip file |
| File deletion fails (permissions) | Log error, skip file |
| `expiredAt` missing or non-UTC format | Skip cleanup for that file (fail-open) |
| Concurrent processing (lock contention) | Skip file, another instance handles it |

## Safety Features

1. **Idempotent**: Re-running won't re-dissolve already-expired chats
2. **Dry-run mode**: `CHAT_DRY_RUN=true` reports actions without executing
3. **Rate limiting**: `CHAT_MAX_PER_RUN` limits batch processing
4. **Concurrency safety**: Uses file locks to prevent race conditions
5. **Graceful degradation**: Group dissolution failure doesn't block status update
6. **Fail-open**: Non-UTC timestamps are skipped rather than rejected

## DO NOT

- ❌ Dissolve groups for chats with user responses (they ended naturally)
- ❌ Process chats that are not in `active` status
- ❌ Delete files within the retention period
- ❌ Create or modify non-chat files
- ❌ Send messages to groups
- ❌ Use MCP tools for group operations (use `lark-cli` only)
