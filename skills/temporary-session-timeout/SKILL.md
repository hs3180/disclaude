---
name: temporary-session-timeout
description: Temporary session timeout and cleanup specialist - detects expired active sessions, dissolves groups via lark-cli, and cleans up stale session files. Use when user says keywords like "会话超时", "清理会话", "session timeout", "session cleanup", "dissolve group", "解散群组". Triggered by schedules or manual invocation to manage session lifecycle end-of-life.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Temporary Session Timeout & Cleanup

Manage the end-of-life of temporary sessions: detect timeouts, dissolve groups, and clean up expired files.

This Skill works with the companion `temporary-session` Skill (session CRUD + activation) and its Schedule. Together they cover the full session lifecycle:

```
temporary-session (Skill)     → Create / Query / List / Respond
temporary-sessions (Schedule)  → Activate pending sessions (create groups)
temporary-session-timeout (THIS Skill)     → Timeout / Dissolve / Cleanup
```

## Single Responsibility

- ✅ Detect expired active sessions (`now >= expiresAt`)
- ✅ Update session status to `expired`
- ✅ Dissolve groups via `lark-cli`
- ✅ Clean up expired session files past retention period
- ❌ DO NOT create sessions (use `/temporary-session` Skill)
- ❌ DO NOT activate sessions (handled by Schedule)
- ❌ DO NOT send messages to groups
- ❌ DO NOT modify sessions in `pending` state
- ❌ DO NOT use MCP tools for group operations (use `lark-cli` only)

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Configuration

- **Session Directory**: `workspace/temporary-sessions/`
- **Retention Period**: 1 hour (expired files older than this are deleted)
- **Dissolve API**: `lark-cli api DELETE /open-apis/im/v1/chats/{chatId}`

## Execution Flow

### Step 0: Environment Check

```bash
# Check lark-cli availability
which lark-cli 2>/dev/null || echo "MISSING:lark-cli"

# Check jq availability
which jq 2>/dev/null || echo "MISSING:jq"

# Ensure session directory exists
mkdir -p workspace/temporary-sessions
```

If `lark-cli` or `jq` is missing, report the error and stop execution.

### Step 1: List Active Sessions

```bash
# Find all active sessions
for f in workspace/temporary-sessions/*.json; do
  [ -f "$f" ] || continue
  status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$status" = "active" ]; then
    echo "$f"
  fi
done
```

If no active sessions found, proceed to Step 4 (cleanup only).

### Step 2: Detect Expired Sessions

For each active session, check if it has timed out:

```bash
now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

for f in workspace/temporary-sessions/*.json; do
  [ -f "$f" ] || continue
  status=$(jq -r '.status' "$f" 2>/dev/null)
  [ "$status" = "active" ] || continue

  expires_at=$(jq -r '.expiresAt' "$f" 2>/dev/null)

  # Compare timestamps (lexicographic comparison works for ISO 8601)
  if [[ "$now" >= "$expires_at" ]]; then
    echo "EXPIRED:$f"
  fi
done
```

### Step 3: Process Each Expired Session

For each expired session, perform the following sub-steps:

#### 3.1 Read Session Data

```bash
id=$(jq -r '.id' "$f")
chat_id=$(jq -r '.chatId' "$f")
response=$(jq -r '.response' "$f")
```

#### 3.2 Check for User Response

Determine whether the session expired with or without a user response:

```bash
has_response=$(jq '.response != null' "$f")

if [ "$has_response" = "true" ]; then
  echo "Session $id expired WITH user response — will dissolve group and mark expired"
else
  echo "Session $id expired WITHOUT user response — will dissolve group and mark expired"
fi
```

Both cases proceed to group dissolution.

#### 3.3 Dissolve Group via lark-cli

```bash
if [ -n "$chat_id" ] && [ "$chat_id" != "null" ]; then
  result=$(lark-cli api DELETE "/open-apis/im/v1/chats/${chat_id}" 2>&1)

  if echo "$result" | jq -e '.code == 0' > /dev/null 2>&1; then
    echo "Group $chat_id dissolved successfully for session $id"
  else
    echo "WARNING: Failed to dissolve group $chat_id for session $id"
    echo "$result"
    # Continue — still mark session as expired even if dissolution fails
  fi
else
  echo "Session $id has no chatId — skipping group dissolution"
fi
```

#### 3.4 Update Session Status to Expired

```bash
now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

tmpfile=$(mktemp /tmp/session-timeout-XXXXXX.json)
jq --arg now "$now" '.status = "expired" | .expiredAt = $now' "$f" > "$tmpfile" \
  && mv "$tmpfile" "$f"
```

### Step 4: Clean Up Stale Expired Files

Remove expired session files that exceed the retention period (default: 1 hour):

```bash
retention_seconds=3600  # 1 hour
now_epoch=$(date -u +"%s")

for f in workspace/temporary-sessions/*.json; do
  [ -f "$f" ] || continue
  status=$(jq -r '.status' "$f" 2>/dev/null)
  [ "$status" = "expired" ] || continue

  # Check if expiredAt exists and is past retention
  expired_at=$(jq -r '.expiredAt // .expiresAt' "$f" 2>/dev/null)
  if [ -z "$expired_at" ] || [ "$expired_at" = "null" ]; then
    # Use expiresAt as fallback if expiredAt not set
    expired_at=$(jq -r '.expiresAt' "$f" 2>/dev/null)
  fi

  expired_epoch=$(date -u -d "$expired_at" +"%s" 2>/dev/null)
  if [ -z "$expired_epoch" ]; then
    echo "WARNING: Cannot parse timestamp for $f — skipping cleanup"
    continue
  fi

  age=$((now_epoch - expired_epoch))
  if [ "$age" -ge "$retention_seconds" ]; then
    echo "CLEANUP: Removing $f (expired ${age}s ago)"
    rm "$f"
  fi
done
```

> **Note**: On macOS, `date -d` is not available. Use the following fallback:
> ```bash
> expired_epoch=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$expired_at" +"%s" 2>/dev/null)
> ```

### Step 5: Summary Report

After processing, output a summary:

```
📋 Session Timeout & Cleanup Report
> **Checked**: N active sessions
> **Expired**: N sessions timed out
> **Groups dissolved**: N successful / N failed
> **Files cleaned**: N stale files removed
```

## Session File Format Reference

```json
{
  "id": "pr-123",
  "status": "active",
  "chatId": "oc_xxx",
  "createdAt": "2026-03-24T10:00:00Z",
  "activatedAt": "2026-03-24T10:01:00Z",
  "expiresAt": "2026-03-25T10:00:00Z",
  "expiredAt": "2026-03-25T10:00:05Z",
  "createGroup": {
    "name": "PR #123 Review",
    "members": ["ou_user1"]
  },
  "context": {"prNumber": 123},
  "response": null
}
```

### Fields Added by This Skill

| Field | Description |
|-------|-------------|
| `expiredAt` | ISO 8601 timestamp set when this skill marks the session as expired |

## State Transitions

| From | To | Trigger | Action |
|------|-----|---------|--------|
| `active` | `expired` | `now >= expiresAt` | Dissolve group, set `expiredAt` |
| `expired` | *(deleted)* | Past retention period | Remove file |

## Error Handling

| Scenario | Action |
|----------|--------|
| `lark-cli` not available | Report error, stop execution |
| `jq` not available | Report error, try `python3` as fallback |
| Group dissolution fails | Log warning, continue — still mark session as expired |
| Session file corrupted (invalid JSON) | Log error, skip file |
| Timestamp parsing fails | Log warning, skip cleanup for that file |
| Session directory doesn't exist | Create it (`mkdir -p`) |
| No active sessions | Skip to cleanup step |

## DO NOT

- ❌ Create or activate sessions (use `/temporary-session` Skill and its Schedule)
- ❌ Use MCP tools for group operations (use `lark-cli` only)
- ❌ Delete `pending` or `active` session files
- ❌ Modify sessions you didn't expire
- ❌ Send messages to groups
- ❌ Execute downstream actions based on session responses
- ❌ Create new scheduled tasks during execution

## Security

- Session ID validation: only `[a-zA-Z0-9._-]` characters (reject path traversal)
- All file operations use canonical paths to prevent directory traversal
- `lark-cli` API calls use the session's own `chatId` field (not user-provided)
