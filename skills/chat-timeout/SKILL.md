---
name: chat-timeout
description: Temporary session timeout detection and group dissolution. Detects expired active chats, dissolves groups via lark-cli (when no user response), marks as expired, and cleans up old expired files. Use when user says keywords like "会话超时", "解散群组", "清理过期会话", "chat timeout", "session cleanup". Triggered by scheduler for automated daily execution.
allowed-tools: [Bash, Read, Write]
---

# Chat Timeout — Expired Temporary Chat Cleanup

Detect and clean up expired temporary chat sessions. Dissolves Feishu groups that have received no user response within their configured timeout period, and removes stale lifecycle records.

## Single Responsibility

- ✅ Detect expired temporary chats (no response + past expiration)
- ✅ Dissolve expired groups via lark-cli
- ✅ Clean up lifecycle records and mapping entries
- ✅ Remove old expired records past retention window
- ❌ DO NOT dissolve chats that have received responses
- ❌ DO NOT create new temporary chats (use chat skill)
- ❌ DO NOT use IPC Channel for group operations

## Execution Flow

### 1. Read All Temporary Chat Records

```bash
ls workspace/schedules/.temp-chats/*.json 2>/dev/null || echo "NO_RECORDS"
```

For each record file, read and parse the JSON to extract:
- `chatId` — The Feishu group chat ID
- `expiresAt` — ISO timestamp of when the chat expires
- `response` — Whether a user has responded (null = no response yet)
- `createdAt` — For retention window calculation

### 2. Classify Records

For each record, determine its status:

| Status | Condition | Action |
|--------|-----------|--------|
| **active** | `expiresAt > now` AND no response | Skip (still valid) |
| **expired-unresponded** | `expiresAt <= now` AND no response | Dissolve group + cleanup |
| **expired-responded** | Has response AND past retention window | Cleanup record only |
| **stale** | `createdAt` > 7 days ago regardless | Cleanup record only |

### 3. Dissolve Expired Unresponded Groups

For each **expired-unresponded** record:

```bash
# Dissolve the Feishu group
lark-cli api DELETE "/open-apis/im/v1/chats/{chatId}"
```

**Important**: If the dissolution API call fails (e.g., group already deleted), proceed with local cleanup anyway. The group may have been manually dissolved by a user.

### 4. Remove Mapping Entries

For each dissolved/cleaned-up chat, remove its entry from `workspace/bot-chat-mapping.json`:

```bash
# Read current mappings
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

Find and remove any entry whose `chatId` matches the dissolved chat. Write back atomically.

### 5. Remove Lifecycle Records

```bash
rm -f "workspace/schedules/.temp-chats/{chatId}.json"
```

### 6. Report Summary

Output a summary of actions taken:

```
📋 Chat Timeout Cleanup Summary:
- Scanned: {total} records
- Active: {active_count} (skipped)
- Dissolved: {dissolved_count} expired groups
- Cleaned: {cleaned_count} stale records
- Errors: {error_count}
```

## Retention Policy

| Record Type | Retention |
|-------------|-----------|
| Active (not expired) | Kept indefinitely |
| Expired + responded | Kept 7 days after expiration |
| Expired + unresponded | Removed immediately after dissolution |
| Dissolution errors | Kept for retry on next execution |

## Error Handling

| Error | Action |
|-------|--------|
| lark-cli not found | Log error, skip dissolution, keep records for retry |
| Dissolution API fails | Log error, keep record for retry on next execution |
| Mapping file read fails | Continue with record cleanup only |
| Record file parse fails | Log warning, skip that record |
| No records found | Exit silently (nothing to clean) |

## Schedule Template

This skill is designed to run on a schedule (e.g., every hour). Example schedule configuration:

```markdown
---
name: chat-timeout
schedule: "0 * * * *"
---

Run the chat-timeout skill to clean up expired temporary chat sessions.
```

## Dependencies

- `lark-cli` (npm: `@larksuite/cli`) — For group dissolution
- `workspace/schedules/.temp-chats/` — ChatStore records
- `workspace/bot-chat-mapping.json` — BotChatMappingStore

## Related

- Companion: chat skill (creates and manages temporary chats)
- Parent: #631 (离线提问机制)
- Pattern: chat-store.ts (TempChatRecord data structure)
