---
name: chat-timeout
description: Detect timed-out active chats, mark them as expired, and dissolve their groups via lark-cli. Primarily invoked by schedules or agents to enforce chat TTL. Use when user says keywords like "超时检测", "chat timeout", "解散群组", "chat dissolution", "/chat-timeout". Also supports direct invocation via /chat-timeout check|list.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Chat Timeout

Detect and handle timed-out active chats. Enforces the TTL (Time-To-Live) of temporary chats by marking expired ones and dissolving their Feishu groups.

## Single Responsibility

- ✅ Detect timed-out active chats (`now >= expiresAt`)
- ✅ Mark timed-out chats as `expired`
- ✅ Dissolve groups for chats without user response via `lark-cli`
- ❌ DO NOT create chats (handled by `chat` skill)
- ❌ DO NOT activate chats (handled by `chats-activation` schedule)
- ❌ DO NOT clean up expired files (handled by `chats-cleanup` schedule)
- ❌ DO NOT send messages to groups (handled by consumer skills)

## Invocation Modes

### Mode 1: Schedule / Agent Invocation (Primary)

Called by schedules or agents to enforce chat TTL:

```
Schedule/Agent → calls this Skill → detects timeouts, dissolves groups
```

No slash command needed; the agent invokes the Skill directly.

### Mode 2: Direct User Invocation

```
/chat-timeout check  — Check and process all timed-out active chats
/chat-timeout list   — List active chats approaching expiration (next 1 hour)
```

## Execution Flow

```bash
npx tsx scripts/chat/timeout.ts
```

The script implements the following logic:

### Step 0: Environment Check (fail-fast)

Verify `lark-cli` is available in PATH. Exit immediately if missing.

### Step 1: List Timed-Out Active Chats

Scan `workspace/chats/*.json` for all chats where:
- `status === "active"`
- `expiresAt <= now` (UTC Z-suffix format comparison)
- Skip chats with non-standard `expiresAt` format (fail-open)

### Step 2: Process Each Timed-Out Chat

For each timed-out active chat:

1. **Acquire exclusive lock** — `flock` on `${filePath}.lock` (non-blocking)
2. **Re-read under lock** — Verify status is still `active` (may have changed)
3. **Check for user response** — `chat.response !== null`
4. **Dissolve group (if no response)** — `lark-cli api DELETE /open-apis/im/v1/chats/{chatId}`
5. **Update status** — Set `status` to `expired` and `expiredAt` to current timestamp
6. **Release lock**

### Dissolution Decision Logic

| Condition | Action |
|-----------|--------|
| No response + has chatId | Dissolve group via lark-cli, then mark expired |
| Has response | Skip dissolution, only mark expired |
| No chatId | Skip dissolution (group was never created), only mark expired |

### Step 3: Summary

Output a summary of processed chats:
- How many were checked
- How many were marked expired
- How many groups were dissolved
- How many errors occurred

## Environment Variables (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_MAX_PER_RUN` | `10` | Max chats to process per execution |

## State Transitions

| Current Status | Condition | Action | New Status |
|----------------|-----------|--------|------------|
| `active` | `expiresAt <= now`, no response | Dissolve group + update | `expired` |
| `active` | `expiresAt <= now`, has response | Update only | `expired` |
| `active` | `expiresAt <= now`, no chatId | Update only | `expired` |

## Error Handling

| Scenario | Action |
|----------|--------|
| `lark-cli` not available | Exit immediately (exit 1) |
| Chat file corrupted (non-JSON) | Log warning, skip |
| Group dissolution fails | Log error, still mark as expired |
| Lock acquisition fails (already locked) | Skip, another instance handling it |
| Non-standard `expiresAt` format | Skip expiry check (fail-open) |
| Chat status changed under lock | Skip, status no longer `active` |

## DO NOT

- ❌ Modify chats with non-active status
- ❌ Dissolve groups for chats with user responses
- ❌ Delete chat files (handled by `chats-cleanup` schedule)
- ❌ Create or activate chats
- ❌ Send messages to groups
- ❌ Use MCP tools for group operations (use `lark-cli` only)
- ❌ Manually delete `.lock` files

## Dependencies

- `@larksuite/cli` (飞书官方 CLI)
- `tsx` (TypeScript execution)
- Node.js 20.12+ (for `fs.flock`)
