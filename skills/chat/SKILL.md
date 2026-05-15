---
name: chat
description: Temporary chat lifecycle management - create, query, list, and dissolve temporary discussion groups. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理". Also supports direct user invocation via /chat create|query|list|dissolve.
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep]
---

# Chat — Temporary Discussion Group Management

Manage temporary Feishu discussion groups for focused conversations. Create groups on demand, dissolve when done, query and list existing groups.

**Use for**: Creating discussion groups, dissolving groups, listing/querying mappings | **Not for**: Sending messages (use MCP `send_text`/`send_interactive`), renaming groups (use `rename-group` skill)

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{chatId}` | Yes | — | Current chat context (from message header) |
| `{messageId}` | No | — | Parent message ID for thread reply |
| `{topic}` | Yes (create) | — | Discussion topic or purpose |
| `{participants}` | No | — | Open IDs of participants to add |

## Data Structure

Mapping file: `workspace/bot-chat-mapping.json` (BotChatMappingStore)

- **Key**: `discussion-{identifier}` (e.g., `discussion-1714800000`, `discussion-pr-feedback`)
- **Purpose**: `discussion`
- **Group name**: `{topic}` (truncated to 50 chars)

## Sub-commands

### `/chat create` — Create Discussion Group

Create a new Feishu discussion group and register it in the mapping table.

#### Steps

**1. Determine topic and key**

Generate a concise topic from the user's request or the triggering context. Create a key using the pattern `discussion-{timestamp}` or a descriptive identifier.

```bash
KEY="discussion-$(date +%s)"
TOPIC="讨论主题"
DESCRIPTION="由 Agent 创建的临时讨论群"
```

**2. Check for duplicates**

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

If a group with the same topic already exists, return the existing chatId instead of creating a new one.

**3. Create the group**

```bash
lark-cli im chat create --name "${TOPIC}" --description "${DESCRIPTION}"
```

Extract `chatId` (format: `oc_xxx`) from the output.

**4. Write to mapping table**

Read `workspace/bot-chat-mapping.json`, add the new entry, and write atomically:

```json
{
  "discussion-1714800000": {
    "chatId": "oc_xxx",
    "createdAt": "2026-05-15T10:00:00.000Z",
    "purpose": "discussion"
  }
}
```

Use a temp file + rename for atomic writes:

```bash
# Read current, add entry, write atomically
node -e '
const fs = require("fs");
const f = "workspace/bot-chat-mapping.json";
let data = {};
try { data = JSON.parse(fs.readFileSync(f, "utf-8")); } catch {}
data["'${KEY}'"] = {
  chatId: "'${CHAT_ID}'",
  createdAt: new Date().toISOString(),
  purpose: "discussion"
};
const tmp = f + "." + Date.now() + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
fs.renameSync(tmp, f);
console.log("OK written:", "'${KEY}'");
'
```

**5. Send context message** (optional but recommended)

Use MCP tools to send an introductory message to the new group:

- `send_text`: Send a brief description of the discussion purpose
- `send_interactive`: Send a card with context and action buttons

**6. Return result**

Report the created group's chatId and key to the caller.

### `/chat list` — List All Groups

List all groups created by the bot.

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

Display all entries in a readable format:

| Key | Chat ID | Purpose | Created At |
|-----|---------|---------|------------|
| `discussion-1714800000` | `oc_xxx` | discussion | 2026-05-15 |

Filter by purpose if needed:
- All groups: show everything
- Discussion only: filter entries where purpose is `discussion`
- PR review only: filter entries where key starts with `pr-`

### `/chat query <key>` — Query Specific Group

Look up a specific group by its mapping key.

```bash
node -e '
const fs = require("fs");
const f = "workspace/bot-chat-mapping.json";
let data = {};
try { data = JSON.parse(fs.readFileSync(f, "utf-8")); } catch {}
const entry = data["'${KEY}'"];
if (entry) {
  console.log(JSON.stringify(entry, null, 2));
} else {
  console.log("Not found: '${KEY}'");
}
'
```

Return the chatId, purpose, and createdAt for the specified key.

### `/chat dissolve` — Dissolve a Group

Dissolve a Feishu group and remove it from the mapping table. **Requires explicit user confirmation.**

#### Steps

**1. Identify the target group**

Parse the user's request to determine which group to dissolve. Accept:
- Mapping key (e.g., `discussion-1714800000`)
- Chat ID (e.g., `oc_xxx`)
- Partial topic match

**2. Confirm before dissolving** (IMPORTANT)

Always ask the user to confirm:

> 确认要解散群「{topic}」({chatId}) 吗？此操作不可撤销。

Use `send_interactive` with approve/reject buttons if in a chat context. Do NOT dissolve without confirmation.

**3. Dissolve the group**

```bash
lark-cli api DELETE /open-apis/im/v1/chats/${CHAT_ID}
```

**4. Remove from mapping table**

```bash
node -e '
const fs = require("fs");
const f = "workspace/bot-chat-mapping.json";
let data = {};
try { data = JSON.parse(fs.readFileSync(f, "utf-8")); } catch {}
const existed = delete data["'${KEY}'"];
if (existed) {
  const tmp = f + "." + Date.now() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fs.renameSync(tmp, f);
  console.log("OK removed: '${KEY}'");
} else {
  console.log("Not found in mapping: '${KEY}'");
}
'
```

**5. Notify user**

Report dissolution result. If the API call fails but the mapping exists, still remove the mapping entry (the group may have already been dissolved manually).

## Error Handling

| Error | Action |
|-------|--------|
| `lark-cli` not found | Report: "lark-cli 未安装，无法执行群操作" |
| Mapping file not found | Treat as empty table `{}` |
| Mapping file write fails | Log error, suggest manual recovery via `/chat list` |
| Group creation fails | Report error, do not write to mapping |
| Dissolution API fails | Still remove mapping entry (group may already be gone) |
| Duplicate key detected | Return existing chatId instead of creating new group |

## Design Principles

1. **Mapping table is a cache** — can be rebuilt from Feishu API (`lark-cli im chats list --as bot`)
2. **User-driven dissolution** — Bot never auto-dissolves; always requires explicit confirmation
3. **Idempotent creation** — Duplicate key returns existing chatId without error
4. **No TTL, no auto-expiry** — Groups persist until explicitly dissolved
5. **Atomic writes** — Temp file + rename pattern for all mapping file modifications
6. **No TypeScript code** — All operations via lark-cli + bash, following pr-scanner pattern

## lark-cli Command Reference

```bash
# Create group
lark-cli im chat create --name "主题" --description "描述"

# Dissolve group
lark-cli api DELETE /open-apis/im/v1/chats/{chatId}

# List bot's groups (for rebuild)
lark-cli im chats list --as bot

# Add members (if needed)
lark-cli im chat.members.create --chat-id {chatId} --member-id-type open_id --body '{"member_id_list":["ou_xxx"]}'
```

## Dependencies

`lark-cli` | `workspace/bot-chat-mapping.json` (BotChatMappingStore) | MCP message tools (`send_text`, `send_interactive`, `send_card`)

## Related

- Parent: #631
- Infrastructure: #2945, #2947, #2946
- Reference pattern: `skills/pr-scanner/SKILL.md`
