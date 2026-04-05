---
name: chat-timeout
description: Detect and expire timed-out temporary chats, dissolve groups via lark-cli. Use when user says keywords like "超时检测", "会话超时", "timeout", "chat timeout", "dissolve group", "解散群组". Also supports scheduled execution.
allowed-tools: [Bash, Read, Glob]
---

# Chat Timeout

Detect timed-out `active` chats, mark them as `expired`, and dissolve the associated Feishu groups via `lark-cli`.

## Single Responsibility

- ✅ Detect timed-out active chats (`now >= expiresAt`)
- ✅ Mark timed-out chats as `expired`
- ✅ Dissolve associated groups via `lark-cli`
- ✅ Skip chats that already have a user response
- ❌ DO NOT create chats (handled by `chat` skill)
- ❌ DO NOT activate chats (handled by `chats-activation` schedule)
- ❌ DO NOT clean up expired files (handled by `chats-cleanup` schedule)
- ❌ DO NOT send messages to groups (handled by consumer skills)

## Invocation Modes

### Mode 1: Direct User Invocation

```
/chat-timeout          — Check and expire all timed-out active chats
/chat-timeout --dry-run — Preview which chats would be expired (no actual changes)
```

### Mode 2: Schedule Invocation

Can be invoked by a schedule for periodic timeout checking.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

## Execution

```bash
# Check and expire timed-out chats
bash scripts/chat/timeout.sh

# Dry run (preview only, no changes)
CHAT_DRY_RUN=1 bash scripts/chat/timeout.sh

# Override max chats per run
CHAT_MAX_PER_RUN=5 bash scripts/chat/timeout.sh
```

### Step 1: Environment Check (fail-fast)

Check `jq`, `flock`, `lark-cli` availability. Exit immediately if any are missing.

### Step 2: List Active Chats

Scan `workspace/chats/*.json` for files with `status=active`.

### Step 3: Check Timeout

For each active chat:
1. Read `expiresAt` (must be UTC Z-suffix format)
2. Compare with current UTC time (`now >= expiresAt`)
3. Skip non-UTC format timestamps (fail-open)

### Step 4: Process Timed-out Chats

For each timed-out chat:

1. **Check for user response**: If `response` field is non-null, skip dissolution (user has responded, let consumer handle it)
2. **Acquire exclusive lock**: `flock -n` for concurrency safety
3. **Re-check status under lock**: Ensure still `active` (another process may have changed it)
4. **Dissolve group via lark-cli**: `lark-cli api DELETE /open-apis/im/v1/chats/{chatId}` with 30s timeout
5. **Mark as expired**: Update `status` to `expired`, set `expiredAt` to current UTC time
6. **Log result**: Report success or failure for each chat

### Step 5: Summary

Report total chats processed, expired, skipped (has response), and failed.

## State Transitions

| Current Status | Condition | Action | New Status |
|---------------|-----------|--------|------------|
| `active` | `now >= expiresAt` + no response | Dissolve group + mark expired | `expired` |
| `active` | `now >= expiresAt` + has response | Mark expired only (no dissolution) | `expired` |
| `active` | `now < expiresAt` | Skip | `active` |

## Error Handling

| Scenario | Action |
|----------|--------|
| `jq`/`flock`/`lark-cli` not available | Exit immediately (fatal) |
| Chat file corrupted | Log warning, skip file |
| Group dissolution fails | Mark as expired anyway (group can be cleaned up later) |
| Lock unavailable | Skip file (another process handling it) |
| Non-UTC `expiresAt` | Skip timeout check (fail-open) |
| `lark-cli` timeout (>30s) | Treat as dissolution failure, proceed |

## Configuration

- **Max chats per run**: 10 (override via `CHAT_MAX_PER_RUN`)
- **lark-cli timeout**: 30 seconds
- **Chat directory**: `workspace/chats/`

## Output Format

```
🔍 Chat Timeout Check
INFO: Found 3 active chat(s)
INFO: Chat pr-123 expired at 2026-03-25T10:00:00Z (no response)
  → Dissolving group oc_xxx... OK
  → Marked as expired
INFO: Chat deploy-456 expired at 2026-03-24T08:00:00Z (has response)
  → Marked as expired (group preserved — user responded)
INFO: Chat ask-789 not yet expired (expires: 2026-03-26T12:00:00Z)
  → Skipping
📊 Summary: 2 expired, 1 skipped, 0 failed
```

## DO NOT

- ❌ Dissolve groups for chats with user responses
- ❌ Modify chats not in `active` status
- ❌ Delete chat files (handled by `chats-cleanup` schedule)
- ❌ Create new chats or modify other files
- ❌ Send messages to groups
