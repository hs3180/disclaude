---
name: "Temporary Sessions Manager"
cron: "*/5 * * * *"
enabled: true
blocking: true
createdAt: 2026-03-24T00:00:00.000Z
---

# Temporary Sessions Manager

Periodically manages temporary session lifecycle: activate pending sessions, expire timed-out sessions, and clean up old files.

## Prerequisites

- `jq` must be installed (required for all JSON operations)
- Feishu credentials configured in `disclaude.config.yaml`

## Session Directory

`workspace/temporary-sessions/` — each session is a JSON file named `{session-id}.json`

## Execution Steps

### Step 1: Ensure sessions directory exists

```bash
mkdir -p workspace/temporary-sessions
```

### Step 2: Scan for pending sessions and activate them

Scan `workspace/temporary-sessions/*.json` for files with `status: "pending"`. For each pending session:

1. Read the session data
2. Create a Feishu group chat via shell script
3. Update the session file to `status: "active"` with the chatId

```bash
SESSIONS_DIR="workspace/temporary-sessions"
SCRIPTS_DIR="skills/temporary-session/scripts"
NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
ACTIVATED_SESSIONS=""

for f in "$SESSIONS_DIR"/*.json; do
  [ -f "$f" ] || continue

  STATUS=$(jq -r '.status' "$f")

  if [[ "$STATUS" != "pending" ]]; then
    continue
  fi

  SESSION_ID=$(jq -r '.id' "$f")
  log_info "Activating pending session: $SESSION_ID"

  # Validate session ID
  if ! echo "$SESSION_ID" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'; then
    log_error "Invalid session ID format: $SESSION_ID, skipping"
    continue
  fi

  # Extract group creation parameters using jq (safe parsing)
  GROUP_NAME=$(jq -r '.createGroup.name' "$f")
  MEMBERS_CSV=$(jq -r '.createGroup.members | join(",")' "$f")

  # Create Feishu group chat via shell script
  GROUP_RESULT=$("$SCRIPTS_DIR/create-group.sh" --name "$GROUP_NAME" --members "$MEMBERS_CSV" 2>&1) || true

  if ! echo "$GROUP_RESULT" | jq -e '.success' >/dev/null 2>&1; then
    log_error "Failed to create group for session $SESSION_ID: $GROUP_RESULT"
    continue
  fi

  CHAT_ID=$(echo "$GROUP_RESULT" | jq -r '.chatId')

  # Update session file to active (using jq, never sed!)
  jq \
    --arg chatId "$CHAT_ID" \
    --arg now "$NOW" \
    '.status = "active" | .chatId = $chatId | .activatedAt = $now' \
    "$f" > "${f}.tmp" && mv "${f}.tmp" "$f"

  log_info "Session $SESSION_ID activated: chatId=$CHAT_ID"

  # Collect activated sessions for card sending in next step
  ACTIVATED_SESSIONS="${ACTIVATED_SESSIONS}${SESSION_ID}\n"
done

# Output activated session IDs for the Agent to use in Step 3
if [[ -n "$ACTIVATED_SESSIONS" ]]; then
  echo -e "ACTIVATED_SESSIONS:\n$ACTIVATED_SESSIONS"
else
  echo "No pending sessions to activate."
fi
```

### Step 3: Send interactive cards to newly activated sessions

**⚡ This step is performed by the Agent (not bash).**

For each session activated in Step 2, the Agent must:

1. Read the session file to get the `message`, `options`, `chatId`, and `id`
2. Build an interactive card with the message and action buttons
3. Call `mcp__channel-mcp__send_interactive` to send the card
4. Include the **session ID** in every action prompt so responses can be routed correctly

**Card construction rules:**
- Read the `message` field from the session JSON file as the card body (Markdown)
- If `options` array exists and is non-empty, add action buttons for each option
- The `actionPrompts` must be a **valid JSON object** where each key is the option's `value` and the value includes the session ID

**Action prompt format:**
Each action prompt must include the session ID so that when the user clicks a button, the Agent knows which session file to update. The format is:

```
[Session Response] Session: {sessionId} | User selected: {optionText} (value: {optionValue})
```

**Example:**
If a session with ID `pr-123` has options `[{"value": "merge", "text": "✅ Merge"}, {"value": "close", "text": "❌ Close"}]`, the Agent should call `mcp__channel-mcp__send_interactive` with:

**chatId**: the `chatId` from the session file

**card**:
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "🔔 临时会话请求", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "{message from session file}"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ Merge", "tag": "plain_text"}, "value": "merge", "type": "primary"},
      {"tag": "button", "text": {"content": "❌ Close", "tag": "plain_text"}, "value": "close", "type": "danger"}
    ]}
  ]
}
```

**actionPrompts** (must be a valid JSON object):
```json
{
  "merge": "[Session Response] Session: pr-123 | User selected: ✅ Merge (value: merge)",
  "close": "[Session Response] Session: pr-123 | User selected: ❌ Close (value: close)"
}
```

**Handling user response:**
When the Agent receives an action prompt, it should:
1. Parse the session ID and selected value from the prompt
2. Read the session file: `workspace/temporary-sessions/{sessionId}.json`
3. Verify the session status is `active`
4. Update the session to `expired` with the response:
```bash
SESSION_ID="{parsed session ID}"
SESSION_FILE="workspace/temporary-sessions/${SESSION_ID}.json"
NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

jq \
  --arg now "$NOW" \
  --arg value "{selected value}" \
  --arg responder "{user open_id}" \
  '{
    id, status: "expired", chatId, messageId, createdAt, activatedAt, expiresAt,
    createGroup, message, options, context,
    response: {
      selectedValue: $value,
      responder: $responder,
      repliedAt: $now
    }
  }' "$SESSION_FILE" > "${SESSION_FILE}.tmp" && mv "${SESSION_FILE}.tmp" "$SESSION_FILE"
```
5. Notify relevant parties based on the response and session context

### Step 4: Expire timed-out sessions

```bash
NOW_EPOCH=$(date -u +%s)
SESSIONS_DIR="workspace/temporary-sessions"
SCRIPTS_DIR="skills/temporary-session/scripts"

for f in "$SESSIONS_DIR"/*.json; do
  [ -f "$f" ] || continue

  STATUS=$(jq -r '.status' "$f")

  if [[ "$STATUS" != "active" ]]; then
    continue
  fi

  EXPIRES_AT=$(jq -r '.expiresAt' "$f")
  EXPIRES_EPOCH=$(date -u -d "$EXPIRES_AT" +%s 2>/dev/null || echo "0")

  if (( NOW_EPOCH >= EXPIRES_EPOCH )); then
    SESSION_ID=$(jq -r '.id' "$f")
    log_info "Expiring timed-out session: $SESSION_ID"

    # Dissolve the group chat
    CHAT_ID=$(jq -r '.chatId // empty' "$f")
    if [[ -n "$CHAT_ID" ]]; then
      "$SCRIPTS_DIR/dissolve-group.sh" --chat-id "$CHAT_ID" || true
    fi

    # Update session to expired (using jq)
    jq '.status = "expired"' "$f" > "${f}.tmp" && mv "${f}.tmp" "$f"
  fi
done
```

### Step 5: Clean up old expired sessions

Delete session files that have been expired for more than 24 hours.

```bash
NOW_EPOCH=$(date -u +%s)
CLEANUP_THRESHOLD_SECONDS=86400  # 24 hours

for f in "$SESSIONS_DIR"/*.json; do
  [ -f "$f" ] || continue

  STATUS=$(jq -r '.status' "$f")

  # Only clean up expired sessions
  if [[ "$STATUS" != "expired" ]]; then
    continue
  fi

  # Use expiredAt field for cleanup decision (not file mtime)
  EXPIRED_AT=$(jq -r '.expiredAt // empty' "$f")
  if [[ -z "$EXPIRED_AT" ]]; then
    # Fallback: use activatedAt if no expiredAt
    EXPIRED_AT=$(jq -r '.activatedAt // empty' "$f")
  fi

  if [[ -n "$EXPIRED_AT" ]]; then
    EXPIRED_EPOCH=$(date -u -d "$EXPIRED_AT" +%s 2>/dev/null || echo "0")
    if (( NOW_EPOCH - EXPIRED_EPOCH > CLEANUP_THRESHOLD_SECONDS )); then
      SESSION_ID=$(jq -r '.id' "$f")
      log_info "Cleaning up old session: $SESSION_ID"
      rm "$f"
    fi
  fi
done
```

## Error Handling

- If group creation fails for a pending session: Log error, skip, retry next cycle
- If card sending fails: Log error, session remains active, retry next cycle
- If dissolve fails: Log error, don't block cleanup
- If session file is corrupted (invalid JSON): Log error, skip

## Important Notes

1. **Always use `jq` for JSON operations** — Never use `sed`, `grep`, or string concatenation for JSON
2. **Atomic file updates** — Always write to `.tmp` file first, then `mv` to final path
3. **Don't create new schedules** — This is a schedule execution environment
4. **Use shell scripts for Feishu API calls** — Agent cannot import npm packages directly
5. **State transitions are forward-only** — pending → active → expired
6. **Card sending is done by the Agent** — Step 3 uses MCP tools, not bash (see pr-scanner.md pattern)
7. **Action prompts must include session ID** — Required for routing user responses to the correct session file
