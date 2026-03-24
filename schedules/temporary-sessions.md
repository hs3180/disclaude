---
name: "Temporary Sessions Manager"
cron: "*/5 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
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

### Step 2: Process pending sessions (activate)

For each session file with `status: "pending"`:

1. Read the session file
2. Create a Feishu group chat using the shell script
3. Send an interactive card to the group
4. Update the session file to `status: "active"`

```bash
SESSIONS_DIR="workspace/temporary-sessions"
SCRIPTS_DIR="skills/temporary-session/scripts"
NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

for f in "$SESSIONS_DIR"/*.json; do
  [ -f "$f" ] || continue

  STATUS=$(jq -r '.status' "$f")

  if [[ "$STATUS" != "pending" ]]; then
    continue
  fi

  SESSION_ID=$(jq -r '.id' "$f")
  log_info "Activating pending session: $SESSION_ID"

  # Extract group creation parameters using jq (safe parsing)
  GROUP_NAME=$(jq -r '.createGroup.name' "$f")
  MEMBERS_CSV=$(jq -r '.createGroup.members | join(",")' "$f")
  MESSAGE=$(jq -r '.message' "$f")
  OPTIONS_JSON=$(jq -c '.options // []' "$f")

  # Step 2a: Create Feishu group chat
  GROUP_RESULT=$("$SCRIPTS_DIR/create-group.sh" --name "$GROUP_NAME" --members "$MEMBERS_CSV")

  if ! echo "$GROUP_RESULT" | jq -e '.success' >/dev/null 2>&1; then
    log_error "Failed to create group for session $SESSION_ID: $GROUP_RESULT"
    continue
  fi

  CHAT_ID=$(echo "$GROUP_RESULT" | jq -r '.chatId')

  # Step 2b: Build and send interactive card
  # Build card elements using jq (no string concatenation!)
  CARD_ELEMENTS=$(jq -n \
    --arg message "$MESSAGE" \
    '[
      {"tag": "markdown", "content": $message},
      {"tag": "hr"}
    ]')

  # Add action buttons if options exist
  OPTIONS_COUNT=$(echo "$OPTIONS_JSON" | jq 'length')
  if [[ "$OPTIONS_COUNT" -gt 0 ]]; then
    ACTIONS=$(echo "$OPTIONS_JSON" | jq -c '
      map({
        tag: "button",
        text: {content: .text, tag: "plain_text"},
        value: .value,
        type: "default"
      })')

    ACTION_ELEMENT=$(jq -n \
      --argjson actions "$ACTIONS" \
      '{"tag": "action", "actions": $actions}')

    CARD_ELEMENTS=$(echo "$CARD_ELEMENTS" | jq --argjson elem "$ACTION_ELEMENT" '. + [$elem]')
  fi

  # Build complete card
  CARD=$(jq -n \
    --argjson elements "$CARD_ELEMENTS" \
    '{
      "config": {"wide_screen_mode": true},
      "header": {
        "title": {"content": "🔔 Temporary Session", "tag": "plain_text"},
        "template": "blue"
      },
      "elements": $elements
    }')

  # Build actionPrompts for interactive card handling
  ACTION_PROMPTS=$(echo "$OPTIONS_JSON" | jq -r '
    if length > 0 then
      map(.value as $val | "\"\($val)\": \"[Session Response] User selected \(.text) for session: " + $val)
      | join(", ")
    else
      ""
    end')

  # Send interactive card via MCP tool
  # Use send_interactive with the card and actionPrompts
  # Note: In schedule context, use the MCP send_interactive tool with:
  #   - card: $CARD (the JSON object above)
  #   - chatId: $CHAT_ID (the group chat ID)
  #   - actionPrompts: parsed from $OPTIONS_JSON

  # Step 2c: Update session file to active (using jq, never sed!)
  jq \
    --arg chatId "$CHAT_ID" \
    --arg now "$NOW" \
    '.status = "active" | .chatId = $chatId | .activatedAt = $now' \
    "$f" > "${f}.tmp" && mv "${f}.tmp" "$f"

  log_info "Session $SESSION_ID activated: chatId=$CHAT_ID"
done
```

### Step 3: Expire timed-out sessions

For each session file with `status: "active"`:

1. Check if `expiresAt` has passed
2. If expired, update `status` to `"expired"` and `response` to `null`

```bash
NOW_EPOCH=$(date -u +%s)

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

### Step 4: Clean up old expired sessions

Delete session files that have been expired for more than 24 hours.

```bash
CLEANUP_THRESHOLD_SECONDS=86400  # 24 hours

for f in "$SESSIONS_DIR"/*.json; do
  [ -f "$f" ] || continue

  STATUS=$(jq -r '.status' "$f")

  # Only clean up expired sessions
  if [[ "$STATUS" != "expired" ]]; then
    continue
  fi

  # Use expiredAt field for cleanup decision (not file mtime)
  EXPIRED_AT=$(jq -r '.expiresAt // empty' "$f")
  if [[ -z "$EXPIRED_AT" ]]; then
    # Fallback: use activatedAt if no expiresAt
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
