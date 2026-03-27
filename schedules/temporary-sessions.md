---
name: "Temporary Sessions Manager"
cron: "0 */5 * * * *"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-03-27T00:00:00.000Z"
---

# Temporary Sessions Lifecycle Manager

Manages the lifecycle of temporary sessions stored in `workspace/temporary-sessions/`.
Handles activation (group creation + card sending), timeout expiration, and cleanup.

## Configuration

- **Session directory**: `workspace/temporary-sessions/`
- **Default timeout**: 60 minutes (per session)
- **Cleanup delay**: 24 hours after expiration
- **Max concurrent activations**: 3 per execution (avoid burst)

## Execution Steps

### Step 1: Check session directory exists

```bash
ls -d workspace/temporary-sessions/ 2>/dev/null && echo "OK" || mkdir -p workspace/temporary-sessions/
```

### Step 2: Activate pending sessions (up to 3)

For each `pending` session file, activate it by creating a group chat and sending an interactive card.

```bash
# List pending sessions (sorted by creation time)
count=0
for f in $(ls -t workspace/temporary-sessions/*.json 2>/dev/null); do
  status=$(jq -r '.status' "$f" 2>/dev/null)
  [ "$status" != "pending" ] && continue
  [ "$count" -ge 3 ] && break
  echo "PENDING:$f"
  count=$((count + 1))
done
```

**For each pending session file**:

1. Read the session configuration:
   ```bash
   jq . workspace/temporary-sessions/{id}.json
   ```

2. **Create group chat** using `create_chat` MCP tool:
   ```
   create_chat({
     name: "{createGroup.name}",
     description: "{createGroup.description}",
     memberIds: {createGroup.memberIds}
   })
   ```

3. If `create_chat` succeeds and returns a `chatId`:

4. **Send interactive card** using `send_interactive` MCP tool to the new group:
   ```
   send_interactive({
     chatId: "{chatId from step 2}",
     title: "{card.title}",
     question: "{card.question}",
     context: "{card.context}",
     options: {options array},
     actionPrompts: {actionPrompts map}
   })
   ```

5. **Update session file** to `active` status:
   ```bash
   now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   jq --arg now "$now" --arg chatId "{chatId}" \
     '.status = "active" | .activatedAt = $now | .chatId = $chatId' \
     workspace/temporary-sessions/{id}.json > /tmp/session_activate.json \
     && mv /tmp/session_activate.json workspace/temporary-sessions/{id}.json
   ```

6. If `create_chat` fails, **skip this session** and try the next one. Log the error.

**Important**:
- Only activate up to 3 sessions per execution to avoid overwhelming the system
- If a session file is malformed (invalid JSON), skip it
- Preserve the original `actionPrompts` from the session file when sending the card

### Step 3: Expire timed-out active sessions

Check all `active` sessions and expire those past their `expiresAt` time.

```bash
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for f in workspace/temporary-sessions/*.json; do
  [ "$(jq -r '.status' "$f" 2>/dev/null)" != "active" ] && continue
  expiresAt=$(jq -r '.expiresAt' "$f" 2>/dev/null)
  [ "$expiresAt" \> "$now" ] && continue
  echo "EXPIRED_BY_TIMEOUT:$f"
done
```

**For each timed-out session**:

1. **Update session** to `expired` with timeout marker:
   ```bash
   now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   jq --arg now "$now" \
     '.status = "expired" | .response = {"selectedValue": "__timeout__", "responder": "system", "repliedAt": $now}' \
     workspace/temporary-sessions/{id}.json > /tmp/session_expire.json \
     && mv /tmp/session_expire.json workspace/temporary-sessions/{id}.json
   ```

2. **Send timeout notification** to the group chat (if chatId exists):
   ```
   send_text({
     chatId: "{chatId}",
     text: "This session has expired due to timeout. The group will be dissolved shortly."
   })
   ```

### Step 4: Clean up old expired sessions

Dissolve group chats for expired sessions older than 24 hours, then delete the session file.

```bash
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Calculate 24 hours ago (approximate with date arithmetic)
cutoff=$(date -u -d "$now - 24 hours" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         date -u -v-24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
         echo "")

for f in workspace/temporary-sessions/*.json; do
  [ "$(jq -r '.status' "$f" 2>/dev/null)" != "expired" ] && continue
  repliedAt=$(jq -r '.response.repliedAt // .activatedAt // .createdAt' "$f" 2>/dev/null)
  [ -z "$cutoff" ] && continue
  [ "$repliedAt" \> "$cutoff" ] && continue
  echo "CLEANUP:$f"
done
```

**For each expired session to clean up**:

1. **Dissolve group chat** (if chatId exists):
   ```
   dissolve_chat({
     chatId: "{chatId}"
   })
   ```

2. **Delete session file**:
   ```bash
   rm workspace/temporary-sessions/{id}.json
   ```

3. If `dissolve_chat` fails, still delete the session file (avoid accumulation of stale files).

### Step 5: Summary

After processing, output a summary:

```
Sessions processed:
- Activated: {count} (from pending)
- Expired: {count} (by timeout)
- Cleaned up: {count} (dissolved + deleted)
- Pending remaining: {count}
- Active remaining: {count}
```

## Error Handling

| Scenario | Action |
|----------|--------|
| `jq` not available | Use `grep`/`sed` for basic JSON field extraction |
| Malformed JSON session file | Skip with warning, don't crash |
| `create_chat` fails | Skip session, try next. Don't update status. |
| `send_interactive` fails | Revert session to `pending` (group exists but card failed) |
| `dissolve_chat` fails | Still delete session file to prevent accumulation |
| Session directory missing | Create it in Step 1 |
| No session files | Exit silently (no-op) |

## Notes

1. **Agent-driven MCP calls**: Group creation and card sending are done by the Agent calling MCP tools, not by bash commands
2. **Bash for file I/O only**: Bash is only used for reading/writing/deleting session JSON files
3. **Action prompts pass through**: The session file's `actionPrompts` are forwarded directly to `send_interactive`, enabling the caller to define custom response handlers
4. **Idempotent**: Re-running the schedule is safe — it checks status before acting
5. **Rate limiting**: Max 3 activations per execution prevents burst group creation
6. **Graceful degradation**: If MCP tools are unavailable, sessions remain in `pending` state and will be retried on next execution

## Dependencies

- MCP Tools: `create_chat`, `dissolve_chat`, `send_interactive`, `send_text`
- Bash utilities: `jq`, `date`, `ls`, `rm`, `mv`
- Session directory: `workspace/temporary-sessions/`
