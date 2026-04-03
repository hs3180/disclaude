---
name: chat-timeout
description: Temporary session timeout and group dissolution - detect expired active chats, dissolve groups via lark-cli, update status, and clean up old expired files. Primarily invoked by scheduled tasks. Use when user says keywords like "会话超时", "超时检测", "解散群组", "chat timeout", "清理会话", "cleanup chats". Also supports direct invocation for manual cleanup.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Chat Timeout

Detect expired active chats, dissolve their Feishu groups via `lark-cli`, update status to `expired`, and clean up old expired files beyond the retention period.

This Skill complements the `chat` Skill and the `chats-activation` Schedule — it handles the **end-of-life** phase of temporary chats.

## Single Responsibility

- ✅ Detect expired active chats (`now >= expiresAt`)
- ✅ Dissolve Feishu groups via `lark-cli` (for chats without user response)
- ✅ Update chat status to `expired`
- ✅ Clean up expired files beyond retention period
- ❌ DO NOT create chats (handled by `chat` Skill)
- ❌ DO NOT activate chats (handled by `chats-activation` Schedule)
- ❌ DO NOT send messages (handled by consumer Skills)
- ❌ DO NOT modify existing code outside `workspace/chats/`

## Invocation

### Scheduled Invocation (Primary)

Triggered periodically by a Schedule to automatically clean up expired chats:

```bash
bash scripts/schedule/chats-timeout.sh
```

### Direct Invocation

For manual cleanup or debugging:

```bash
# Run with defaults (1-hour retention)
bash scripts/schedule/chats-timeout.sh

# Custom retention period (in seconds)
CHAT_RETENTION_SECONDS=7200 bash scripts/schedule/chats-timeout.sh

# Dry run — show what would be done without actually doing it
CHAT_DRY_RUN=true bash scripts/schedule/chats-timeout.sh
```

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Execution Flow

```
Step 1: List all active chats
Step 2: Check each chat for timeout (now >= expiresAt)
Step 3: For each expired chat:
  ├─ Check if user has responded (response field)
  ├─ No response → dissolve group via lark-cli
  │   └─ lark-cli im +chat-delete --chat-id {chatId}
  ├─ Update status to expired
Step 4: Clean up expired files beyond retention period
  └─ Delete files where expiredAt > retention threshold
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_MAX_PER_RUN` | `10` | Max chats to process per execution |
| `CHAT_RETENTION_SECONDS` | `3600` | Retention period for expired files (default: 1 hour) |
| `CHAT_DRY_RUN` | `false` | If `true`, log actions without executing them |
| `LARK_TIMEOUT` | `30` | Timeout for lark-cli API calls (seconds) |

## State Transitions

| Current State | Condition | Action | New State |
|---------------|-----------|--------|-----------|
| `active` | `expiresAt` past AND no response | Dissolve group + update status | `expired` |
| `active` | `expiresAt` past AND has response | Update status only (no dissolution) | `expired` |
| `active` | `expiresAt` not past | Skip | `active` (unchanged) |
| `expired` | Past retention period | Delete file | (removed) |
| `expired` | Within retention period | Skip | `expired` (unchanged) |

## Group Dissolution Logic

Only chats **without** a user response get their groups dissolved:

| Scenario | Dissolve Group? | Reason |
|----------|----------------|--------|
| No response, expired | ✅ Yes | User never replied, group serves no purpose |
| Has response, expired | ❌ No | Group may contain useful context for the consumer |
| No response, not expired | N/A | Not processed |

## Error Handling

| Scenario | Action |
|----------|--------|
| `lark-cli`/`jq`/`flock`/`timeout` unavailable | Exit immediately (fatal) |
| Group dissolution fails | Log error, still mark as `expired` |
| `lark-cli` times out | Log timeout error, still mark as `expired` |
| Chat file corrupted (invalid JSON) | Log warning, skip file |
| File deletion fails | Log warning, continue with other files |
| Concurrent processing | `flock -n` non-blocking lock, skip locked files |
| Chat status changed under lock | Re-check and skip if no longer `active` |

## Chat Directory

```
workspace/chats/
├── pr-123.json              # Active → will be checked for timeout
├── offline-deploy-456.json  # Expired → will be cleaned up after retention
└── ask-review-789.json      # Pending → not processed by this Skill
```

## Dependencies

- `lark-cli` (Feishu official CLI, npm global install)
- `jq` (JSON processing)
- `flock` (Linux file locking, util-linux)
- `timeout` (GNU coreutils — Linux only; macOS needs `gtimeout`)

## DO NOT

- ❌ Create or activate chats (handled by `chat` Skill and `chats-activation`)
- ❌ Send messages to groups (consumer Skill's responsibility)
- ❌ Process `pending` or `failed` status chats (not this Skill's concern)
- ❌ Modify files outside `workspace/chats/`
- ❌ Delete `.lock` files manually (they auto-clean on unlock)
- ❌ Dissolve groups for chats with user responses

## Example Output

```
INFO: Found 3 active chat(s)
INFO: Chat pr-123 expired at 2026-03-25T10:00:00Z (no response)
INFO: Dissolving group oc_abc123 for chat pr-123...
OK: Chat pr-123 marked as expired (group dissolved)
INFO: Chat deploy-456 expired at 2026-03-24T08:00:00Z (has response)
OK: Chat deploy-456 marked as expired (group preserved, has response)
INFO: Chat ask-789 expires at 2026-03-26T10:00:00Z (not expired, skipping)
INFO: Cleaning up 2 expired file(s) beyond retention (3600s)
INFO: Removed offline-old-999.json (expired 7200s ago)
INFO: Removed stale-888.json (expired 5400s ago)
INFO: Processed 3 chat(s) in this run
```
