---
name: chat
description: Temporary chat lifecycle management - create, query, list, and respond to temporary chats. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理". Also supports direct user invocation via /chat create|query|list.
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# Temporary Chat Lifecycle Management

Manage temporary Feishu group chats for non-blocking offline discussions. Use lark-cli for group operations and MCP tools for messaging.

## Single Responsibility

- ✅ Create temporary Feishu groups via lark-cli
- ✅ Register mappings in `bot-chat-mapping.json`
- ✅ Send context/questions via MCP tools
- ✅ Query and list active temporary chats
- ✅ Dissolve groups via lark-cli raw API
- ❌ DO NOT use MCP tools for group operations (removed in #1912)
- ❌ DO NOT implement state machines (simplified design)
- ❌ DO NOT manage group members beyond creation scope

## Context Variables

When invoked, you receive:
- **Chat ID**: The current Feishu chat ID (from "**Chat ID:** xxx" in the message)
- **Message ID**: The message ID (from "**Message ID:** xxx" in the message)

## Commands

### `/chat create <topic> [--users <open_ids>] [--expires <hours>]`

Create a temporary Feishu group for offline discussion.

**Arguments**:
- `<topic>` — The discussion topic (used as group name)
- `--users <open_ids>` — Comma-separated user open_id list to add (optional)
- `--expires <hours>` — Hours until expiry (default: 24)

**Steps**:

1. **Generate a mapping key**: `discussion-{sanitized_topic}-{timestamp}`
   - Use lowercase, replace spaces with hyphens
   - Keep it short: max 40 chars for the key

2. **Check for existing mapping**: Read `workspace/bot-chat-mapping.json`
   - If a mapping with purpose `discussion` already exists for a similar key, reuse that chatId

3. **Create the group via lark-cli**:
   ```bash
   CHAT_CREATE_NAME="讨论: {topic}"
   lark-cli im +chat-create --name "$CHAT_CREATE_NAME"
   ```
   - Parse the response to extract the `chatId` (oc_xxx format)
   - If users are specified, add them:
     ```bash
     lark-cli im chat.members create \
       --params '{"chat_id":"{chatId}","member_id_type":"open_id","succeed_type":1}' \
       --data '{"id_list":["{user_id_1}","{user_id_2}"]}' --as user
     ```

4. **Register the mapping**: Update `workspace/bot-chat-mapping.json`
   ```json
   {
     "discussion-{key}": {
       "chatId": "oc_xxx",
       "createdAt": "2026-05-02T12:00:00.000Z",
       "purpose": "discussion"
     }
   }
   ```

5. **Create lifecycle record**: Write to `workspace/schedules/.temp-chats/{chatId}.json`
   ```json
   {
     "chatId": "oc_xxx",
     "createdAt": "2026-05-02T12:00:00.000Z",
     "expiresAt": "2026-05-03T12:00:00.000Z",
     "creatorChatId": "{current_chat_id}",
     "context": {
       "topic": "{topic}",
       "key": "discussion-{key}"
     }
   }
   ```

6. **Send the question**: Use MCP `send_text` or `send_interactive` to send context to the new group:
   ```
   MCP: send_text(chatId="{new_chatId}", text="...question content...")
   ```

7. **Report success**: Reply in the original chat with the new chatId and expiry info

### `/chat query <chatId_or_key>`

Query a temporary chat's status.

**Steps**:

1. **Resolve the chatId**:
   - If argument starts with `oc_`, use directly
   - Otherwise, look up in `workspace/bot-chat-mapping.json` for matching key

2. **Check lifecycle record**: Read `workspace/schedules/.temp-chats/{chatId}.json`
   - If exists: show creation time, expiry, response status
   - If not found: report "no active temporary chat"

3. **Report status**:
   - ⏳ **Pending** — created, no response yet, not expired
   - ✅ **Responded** — user has replied
   - ⌛ **Expired** — past expiry, no response
   - ❌ **Not found** — no record exists

### `/chat list`

List all active temporary chats.

**Steps**:

1. **Read mappings**: Read `workspace/bot-chat-mapping.json`, filter entries with `purpose: "discussion"`
2. **Read lifecycle records**: For each mapped chatId, read `workspace/schedules/.temp-chats/{chatId}.json`
3. **Format as table**:
   ```
   | Key | Chat ID | Topic | Status | Created | Expires |
   |-----|---------|-------|--------|---------|---------|
   | discussion-x | oc_xxx | ... | ⏳ Pending | ... | ... |
   ```

### `/chat dissolve <chatId_or_key>`

Dissolve a temporary chat group and clean up records.

**Steps**:

1. **Resolve the chatId** (same as query)

2. **Dissolve the group via lark-cli**:
   ```bash
   lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
   ```

3. **Remove mapping**: Delete the entry from `workspace/bot-chat-mapping.json`

4. **Remove lifecycle record**: Delete `workspace/schedules/.temp-chats/{chatId}.json`

5. **Report success**: Confirm group dissolved and records cleaned up

## Architecture

```
Agent ──Bash──> lark-cli <command> ──> Feishu API   (group operations)
Agent ──MCP──> send_text/send_interactive           (message sending)
Agent ──Read/Write──> workspace/bot-chat-mapping.json   (chatId mappings)
Agent ──Read/Write──> workspace/schedules/.temp-chats/  (lifecycle records)
```

**No IPC, no MCP tools for group management.** All group operations go through lark-cli directly.

## Group Name Convention

Temporary discussion groups use the naming pattern:
```
讨论: {topic}
```

This allows `BotChatMappingStore.parseGroupNameToKey()` to potentially recognize them during API scans for self-healing.

## Error Handling

- **lark-cli not found**: Report that lark-cli is not installed, suggest `npm install -g @larksuite/cli`
- **Group creation fails**: Log error, do NOT create mapping or lifecycle record
- **Dissolution fails**: Still remove local records (group may already be deleted), log warning
- **Mapping file corrupted**: Log warning, proceed with current operation

## Safety Guarantees

- **Idempotent**: Creating a chat with an existing key returns the existing chatId
- **Validation**: All chat IDs must match `oc_xxx` format before lark-cli calls
- **No orphan cleanup**: Dissolution removes all local records even if API call fails
- **Expiry-driven**: Expired chats are handled by the `chat-timeout` skill, not this skill
