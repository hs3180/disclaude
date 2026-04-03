---
name: "Chat Activation"
cron: "*/5 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-04-03T00:00:00.000Z"
---

# Chat Activation Schedule

Automatically activates pending chat sessions by creating Feishu groups via `lark-cli`, and expires timed-out active chats by dissolving their groups.

## Background

Part of the temporary group chat lifecycle management system (Issue #1547).

- **This schedule**: Activates pending chats and expires timed-out active chats
- **`skills/chat/SKILL.md`**: Creates/manages chat JSON files
- **`skills/chat-timeout/SKILL.md`**: Handles detailed timeout detection
- **`schedules/chats-cleanup.md`**: Cleans up stale expired files

## Configuration

- **Scan interval**: Every 5 minutes
- **Chat directory**: `workspace/chats/`
- **Max activation attempts**: 3 (before marking as failed)
- **Group tool**: `lark-cli` (Feishu official CLI)

## Execution Steps

### Step 1: Ensure chat directory exists

```bash
mkdir -p workspace/chats
```

### Step 2: List all pending chats

```bash
# Find all pending chat files
for f in workspace/chats/*.json; do
  status=$(python3 -c "import json,sys; d=json.load(open('$f')); print(d.get('status',''))" 2>/dev/null)
  if [ "$status" = "pending" ]; then
    echo "$f"
  fi
done
```

If no pending chats found, proceed to Step 5 (check for expired active chats).

### Step 3: Activate each pending chat

For each pending chat file:

1. **Read the chat file** to extract fields:
   - `id`, `createGroup.name`, `createGroup.members`, `expiresAt`, `activationAttempts`

2. **Check activation limit**:
   - If `activationAttempts >= 3`, skip this chat and mark as failed:
     ```bash
     python3 -c "
     import json, sys
     from datetime import datetime, timezone
     f = sys.argv[1]
     with open(f) as fp:
         d = json.load(fp)
     d['status'] = 'failed'
     d['failedAt'] = datetime.now(timezone.utc).isoformat()
     d['lastActivationError'] = 'Max activation attempts (3) reached'
     with open(f, 'w') as fp:
         json.dump(d, fp, indent=2, ensure_ascii=False)
     " "$chat_file"
     ```
   - Continue to next pending chat.

3. **Create group via `lark-cli`**:
   ```bash
   lark-cli im +chat-create \
     --name "{createGroup.name}" \
     --users "{members_comma_separated}"
   ```

   - `{members_comma_separated}`: Join `createGroup.members` array with commas
   - Example: `lark-cli im +chat-create --name "PR #123 Review" --users "ou_user1,ou_user2"`

4. **Handle `lark-cli` result**:
   - If successful, extract the `chatId` from the output and update the chat file:
     ```bash
     python3 -c "
     import json, sys
     from datetime import datetime, timezone
     f = sys.argv[1]
     chat_id = sys.argv[2]
     with open(f) as fp:
         d = json.load(fp)
     d['status'] = 'active'
     d['chatId'] = chat_id
     d['activatedAt'] = datetime.now(timezone.utc).isoformat()
     d['activationAttempts'] = d.get('activationAttempts', 0) + 1
     d['lastActivationError'] = None
     with open(f, 'w') as fp:
         json.dump(d, fp, indent=2, ensure_ascii=False)
     " "$chat_file" "$chat_id"
     ```
   - If failed, increment `activationAttempts` and record the error:
     ```bash
     python3 -c "
     import json, sys
     from datetime import datetime, timezone
     f = sys.argv[1]
     error_msg = sys.argv[2]
     with open(f) as fp:
         d = json.load(fp)
     d['activationAttempts'] = d.get('activationAttempts', 0) + 1
     d['lastActivationError'] = error_msg
     with open(f, 'w') as fp:
         json.dump(d, fp, indent=2, ensure_ascii=False)
     " "$chat_file" "lark-cli failed: {error_output}"
     ```

### Step 4: Report activation results

After processing all pending chats, summarize results:

```
📋 Chat Activation Summary:
- ✅ Activated: {count} ({list of IDs})
- ⏳ Retried: {count} ({list of IDs with attempt count})
- ❌ Failed: {count} ({list of IDs with reasons})
```

### Step 5: Check for expired active chats

```bash
# Find all active chats that have passed their expiration time
python3 -c "
import json, os, glob
from datetime import datetime, timezone

now = datetime.now(timezone.utc).isoformat()
expired = []

for f in glob.glob('workspace/chats/*.json'):
    with open(f) as fp:
        d = json.load(fp)
    if d.get('status') != 'active':
        continue
    expires = d.get('expiresAt')
    if not expires:
        continue
    if now >= expires:
        expired.append(f)

for f in expired:
    print(f)
"
```

### Step 6: Dissolve expired groups via `lark-cli`

For each expired active chat:

1. **Read the chat file** to get `chatId`
2. **Dissolve the group**:
   ```bash
   lark-cli api DELETE "/open-apis/im/v1/chats/{chatId}"
   ```
3. **Update the chat file**:
   ```bash
   python3 -c "
   import json, sys
   from datetime import datetime, timezone
   f = sys.argv[1]
   with open(f) as fp:
       d = json.load(fp)
   d['status'] = 'expired'
   with open(f, 'w') as fp:
       json.dump(d, fp, indent=2, ensure_ascii=False)
   " "$chat_file"
   ```

### Step 7: Report expiration results

```
📋 Chat Expiration Summary:
- ⚫ Expired: {count} ({list of IDs})
- ⚠️ Dissolve failed: {count} ({list of IDs with reasons})
```

## Error Handling

| Scenario | Action |
|----------|--------|
| `workspace/chats/` does not exist | Create it with `mkdir -p` and exit |
| `lark-cli` not installed | Report error and skip all group operations |
| `lark-cli` authentication expired | Report error, skip activation, retry next cycle |
| Chat file is invalid JSON | Log warning, skip this file |
| `lark-cli` output cannot be parsed | Increment `activationAttempts`, record error |
| Group already exists | Treat as success if `chatId` can be extracted |

## Important Notes

1. **Serial processing**: Process chats one at a time to avoid race conditions
2. **Atomic updates**: Use Python one-liners to read-modify-write chat files atomically
3. **Max retries**: After 3 failed activation attempts, mark chat as `failed` permanently
4. **No message sending**: This schedule only manages group lifecycle — message content is the responsibility of the consumer skill that created the chat
5. **Stateless execution**: Each run is independent — all state is derived from chat files

## DO NOT

- ❌ Send messages to created groups (consumer skill's responsibility)
- ❌ Use MCP tools (`create_chat`/`dissolve_chat`) for group operations
- ❌ Delete chat files (handled by `chats-cleanup` schedule)
- ❌ Modify `createGroup` or `context` fields
- ❌ Create new scheduled tasks
