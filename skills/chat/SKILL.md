---
name: chat
description: Temporary chat lifecycle management - create, query, list, and respond to temporary chats. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理". Also supports direct user invocation via /chat create|query|list.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Chat — Temporary Chat Lifecycle Management

Manages temporary discussion chats: create Feishu groups with context, query/list active chats, and respond to pending chats.

**Does**: Create discussion groups, track mappings, list/query active temp chats, respond to pending chats
**Does not**: Dissolve groups (see `chat-timeout` skill), send interactive cards (use `send_interactive` MCP tool directly)

## Context Variables

These are injected at runtime by the agent system:

| Variable | Description |
|----------|-------------|
| `{chatId}` | Current chat ID (e.g. `oc_xxx`) |
| `{messageId}` | Current message ID |
| `{senderOpenId}` | Sender's Open ID |

## Data Structures

### Mapping File: `workspace/bot-chat-mapping.json`

Uses `BotChatMappingStore` format. Temp chat entries:

```
{
  "temp-<uuid>": {
    "chatId": "oc_xxx",
    "createdAt": "2026-05-20T10:00:00.000Z",
    "purpose": "discussion",
    "topic": "Code Review: PR #123",
    "creatorChatId": "oc_yyy",
    "status": "active"
  }
}
```

Key format: `temp-{short-uuid}` (first 8 chars of UUID)

### Status Values

| Status | Meaning |
|--------|---------|
| `active` | Chat is live, waiting for or receiving responses |
| `responded` | At least one user has responded |
| `expired` | Timed out without response (set by `chat-timeout` skill) |

## Commands

The skill supports three sub-commands: `create`, `query`, `list`, `respond`.

### `/chat create` — Create a Temporary Discussion Chat

Creates a new Feishu group, injects initialization context, and records the mapping.

**Required arguments**:
- `topic` — Discussion topic/title (used as group name)
- `context` — Background information to inject into the new group's agent

**Optional arguments**:
- `participants` — Open IDs of users to add (comma-separated)
- `purpose` — Purpose tag (default: `discussion`)

**Workflow**:

1. **Generate a unique key**:
   ```bash
   KEY="temp-$(uuidgen | cut -d'-' -f1)"
   ```

2. **Create Feishu group** via lark-cli:
   ```bash
   lark-cli im chat create \
     --name "{topic}" \
     --description "临时讨论: {topic}"
   ```

   Parse the `chatId` from the output.

3. **Add participants** (if specified):
   ```bash
   for openId in {participants}; do
     lark-cli im chat add-member --chat-id "{chatId}" --open-id "$openId"
   done
   ```

4. **Inject initialization prompt** via IPC `pushToAgent`:
   ```bash
   # pushToAgent triggers lazy agent creation and injects a system instruction
   # The IPC call is handled via the MCP channel-mcp server
   ```
   Send the context as the initialization message to the new group's agent, including:
   - The topic and purpose of the discussion
   - The creator's chatId (for traceability)
   - Any background information provided

5. **Record mapping**:
   Write to `workspace/bot-chat-mapping.json`:
   ```json
   {
     "temp-{uuid}": {
       "chatId": "{chatId}",
       "createdAt": "{ISO timestamp}",
       "purpose": "discussion",
       "topic": "{topic}",
       "creatorChatId": "{current chatId}",
       "status": "active"
     }
   }
   ```
   Preserve existing entries. Use atomic write (temp file + rename).

6. **Return result** to caller:
   ```
   Temporary chat created:
   - Key: temp-{uuid}
   - Chat ID: {chatId}
   - Topic: {topic}
   - Status: active
   ```

### `/chat list` — List Active Temporary Chats

Lists all temp chats from the mapping file.

**Workflow**:

1. Read `workspace/bot-chat-mapping.json`
2. Filter entries where key starts with `temp-`
3. Format as a readable table:

```
| Key | Topic | Status | Created | Chat ID |
|-----|-------|--------|---------|---------|
| temp-a1b2c3d4 | Code Review PR #123 | active | 2026-05-20 10:00 | oc_xxx |
| temp-e5f6g7h8 | Bug Investigation | responded | 2026-05-19 15:30 | oc_yyy |
```

If no temp chats exist, output: `No active temporary chats.`

### `/chat query <key>` — Query a Specific Temp Chat

Looks up details for a specific temporary chat.

**Required arguments**:
- `key` — The temp chat key (e.g. `temp-a1b2c3d4`)

**Workflow**:

1. Read mapping file, find entry by key
2. If not found: `Temp chat "{key}" not found.`
3. If found, display:
   ```
   Temp Chat: {key}
   - Topic: {topic}
   - Status: {status}
   - Chat ID: {chatId}
   - Creator Chat: {creatorChatId}
   - Created: {createdAt}
   - Purpose: {purpose}
   ```

### `/chat respond <key>` — Mark a Temp Chat as Responded

Marks a temp chat as having received a user response.

**Required arguments**:
- `key` — The temp chat key

**Optional arguments**:
- `value` — The response value (e.g. selected option from an interactive card)

**Workflow**:

1. Read mapping file, find entry by key
2. If not found: `Temp chat "{key}" not found.`
3. Update entry status to `responded`
4. If `value` provided, record it:
   ```json
   {
     "temp-{uuid}": {
       ...existing fields...,
       "status": "responded",
       "response": {
         "selectedValue": "{value}",
         "responder": "{senderOpenId}",
         "repliedAt": "{ISO timestamp}"
       }
     }
   }
   ```
5. Atomic write back to mapping file
6. Output: `Temp chat "{key}" marked as responded.`

## Error Handling

| Error | Action |
|-------|--------|
| `lark-cli` not available | Report error: "lark-cli is required for chat creation" |
| Group creation fails | Report error with lark-cli output, do not write mapping |
| Mapping file read fails | Treat as empty mapping, create new file on write |
| Mapping file write fails | Log error, report to user (group was created but mapping not saved) |
| IPC pushToAgent fails | Log warning (group is created, agent will initialize on first message) |
| Key not found in query/respond | Report "not found" to user |

## Design Principles

1. **Orchestration guide, not code** — This skill is a SKILL.md that guides the agent's behavior, not a TypeScript module
2. **Mapping table is cache** — Can be rebuilt from Feishu API via `BotChatMappingStore.rebuildFromGroupList()`
3. **Idempotent operations** — Creating with same topic checks for existing mapping first
4. **Non-blocking** — `create` returns immediately after setup; it does not wait for responses
5. **Atomic writes** — Always use temp file + rename pattern for mapping file persistence

## Dependencies

- `lark-cli` — Feishu group management CLI
- `workspace/bot-chat-mapping.json` — BotChatMappingStore
- IPC `pushToAgent` — Agent initialization in new groups

## Related Skills

- `chat-timeout` — Scheduled task for expiring and dissolving stale temp chats
- `start-discussion` — Higher-level skill for non-blocking discussions (uses this skill internally)
- `survey` — Polling/voting within temporary chats
