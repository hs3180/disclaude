---
name: chat-timeout
description: Temporary chat timeout and group dissolution - expire timed-out active chats, dissolve groups via lark-cli, and clean up old expired files. Use when user says keywords like "过期会话", "超时检测", "chat timeout", "会话过期", "清理会话", "解散群组". Also supports scheduled execution for automatic timeout management.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Chat Timeout Manager

Expire timed-out active chats, dissolve their associated Feishu groups, and clean up old expired chat files. This skill completes the temporary chat lifecycle started by the `chat` skill.

## Single Responsibility

- ✅ Detect timed-out active chats (`now >= expiresAt`)
- ✅ Mark timed-out chats as `expired` with `expiredAt` timestamp
- ✅ Dissolve associated Feishu groups via `lark-cli` (best-effort)
- ✅ Clean up expired chat files past retention period
- ❌ DO NOT create or activate chats (handled by `chat` skill + `chats-activation` schedule)
- ❌ DO NOT send messages to groups (handled by consumer skills)
- ❌ DO NOT handle user responses (handled by `chat` skill)

## Context

This skill works alongside the `chat` skill and `chats-activation` schedule to manage the full temporary chat lifecycle:

```
chat skill → chats-activation schedule → [user interaction] → chat-timeout skill → chats-cleanup schedule
  creates       activates groups                                  expires & dissolves    removes files
```

## Operations

### 1. Expire Timed-Out Chats

Detect active chats past their `expiresAt` and mark them as expired:

```bash
bash scripts/chat/expire.sh
```

**Behavior:**
1. Scans all `active` chats in `workspace/chats/`
2. Checks if `now >= expiresAt` (UTC Z-suffix format comparison)
3. For each expired chat:
   - Acquires exclusive lock (`flock`)
   - Attempts to dissolve group via `lark-cli api DELETE /open-apis/im/v1/chats/{chatId}`
   - Updates status to `expired` and sets `expiredAt` timestamp
4. Group dissolution failure does NOT prevent expiration marking

**Environment variables (optional):**
- `CHAT_MAX_PER_RUN`: Max chats to process per run (default: 10)

**Design decisions:**

| Decision | Rationale |
|----------|-----------|
| `lark-cli` for dissolution (not MCP) | MCP tools are prohibited for group operations |
| Best-effort dissolution | A stale group is better than a chat stuck in `active` forever |
| `lark-cli` optional | Chat expiration must work even without `lark-cli` installed |

### 2. Clean Up Old Expired Files

Remove expired chat files that have passed the retention period:

```bash
bash scripts/chat/cleanup.sh
```

**Behavior:**
1. Scans all `expired` chats in `workspace/chats/`
2. Checks age against retention period (default: 1 hour)
3. For each eligible chat:
   - Acquires exclusive lock
   - Re-verifies status under lock
   - Deletes the chat JSON file and its `.lock` file

**Environment variables (optional):**
- `CHAT_CLEANUP_RETENTION`: Retention period in seconds (default: 3600 = 1 hour)
- `CHAT_MAX_PER_RUN`: Max chats to process per run (default: 50)

## State Transitions

| Current Status | Condition | Action | New Status |
|----------------|-----------|--------|------------|
| `active` | `expiresAt <= now` | Mark expired + dissolve group | `expired` |
| `active` | `expiresAt <= now` + dissolution fails | Mark expired anyway | `expired` |
| `active` | `expiresAt > now` | Skip (not yet expired) | `active` |
| `expired` | age < retention | Skip (too recent) | `expired` |
| `expired` | age >= retention | Delete file + lock | *(deleted)* |

## Error Handling

| Scenario | Action |
|----------|--------|
| `jq` not available | Fatal exit (required dependency) |
| `lark-cli` not available | Warn + skip dissolution (still mark expired) |
| `lark-cli` timeout (>30s) | Warn + continue (still mark expired) |
| Chat file corrupted | Warn + skip |
| Lock unavailable | Info + skip (another process handling it) |
| Status changed under lock | Info + skip (idempotent) |
| Non-UTC `expiresAt` format | Warn + skip (fail-open) |

## Prerequisites

### Required
- `jq` — JSON processing

### Optional
- `lark-cli` — Feishu group dissolution (chats are still expired without it)
- `flock` — Concurrency safety (Linux-only, util-linux)
- `timeout` — lark-cli timeout protection (Linux-only)

## Related

- **Depends on**: PR #1936 (temporary chat lifecycle management) — merged ✅
- **Companion schedule**: `chats-activation` (activates pending chats)
- **Cleanup schedule**: `chats-cleanup` (periodic file cleanup)
- **Part of**: #1547 (temporary chat schedule integration)

## DO NOT

- ❌ Create, activate, or modify pending chats
- ❌ Send messages to groups
- ❌ Handle user responses
- ❌ Use MCP tools for group operations
- ❌ Modify files outside `workspace/chats/`
- ❌ Create or modify schedules
- ❌ Delete `.lock` files manually (handled by cleanup script)
- ❌ Block expiration on lark-cli failure
