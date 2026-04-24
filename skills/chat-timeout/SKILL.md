---
name: chat-timeout
description: Temporary session timeout detection and group dissolution. Detects expired active chats, dissolves groups via lark-cli (when no user response), marks as expired, and cleans up old expired files. Use when user says keywords like "会话超时", "解散群组", "清理过期会话", "chat timeout", "session cleanup".
user-invocable: false
---

# Chat Timeout Manager

Detect expired active temporary chats, dissolve groups, and clean up expired files.

## Single Responsibility

- ✅ Detect expired active chats (`now >= expiresAt`)
- ✅ Dissolve groups via lark-cli (only when no user response)
- ✅ Mark chats as expired
- ✅ Clean up expired files past retention period
- ❌ DO NOT send messages to groups
- ❌ DO NOT activate pending chats (handled by `chats-activation` schedule)
- ❌ DO NOT create new chats (handled by `chat` skill)
- ❌ DO NOT use MCP tools for group operations

## Execution

This skill is primarily triggered by the `chat-timeout` Schedule (every 5 minutes).

### Manual Execution

```bash
npx tsx skills/chat-timeout/chat-timeout.ts
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_MAX_PER_RUN` | `10` | Max chats to process per execution |
| `CHAT_EXPIRED_RETENTION_HOURS` | `1` | Hours to retain expired files before cleanup |

## Execution Flow

```
Step 1: Scan workspace/chats/ for active chats
Step 2: Check if expiresAt has passed (now >= expiresAt)
Step 3: For each expired active chat:
  ├─ Check if user has responded (response field)
  ├─ No response → lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
  ├─ Has response → skip group dissolution
  └─ Update status to expired, set expiredAt timestamp
Step 4: Clean up expired files past retention period (default: 1 hour)
```

## State Transitions

| Current Status | Condition | Action | New Status |
|----------------|-----------|--------|------------|
| `active` | `expiresAt` passed, no response | Dissolve group + mark expired | `expired` |
| `active` | `expiresAt` passed, has response | Mark expired only | `expired` |
| `expired` | Past retention period | Delete file | (removed) |

## Safety Guarantees

- **Idempotent**: Repeated execution is safe (double-check under lock)
- **Concurrency-safe**: Uses PID-based file locking (zero dependencies, works on all Node.js versions)
- **Graceful degradation**: Group dissolution failure doesn't block status update
- **Rate-limited**: Max 10 chats per execution to prevent API throttling
- **Response-aware**: Groups with user responses are preserved for consumer reading

## Related Components

| Component | Role |
|-----------|------|
| `chat` skill | Creates/manages chat lifecycle (pending → active) |
| `chats-activation` schedule | Activates pending chats (creates groups) |
| `chats-cleanup` schedule | Cleans up orphaned `.lock` files |
| **This skill** | Expires active chats (dissolves groups + cleanup) |
