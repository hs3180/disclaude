---
name: context-offloading
description: Context Offloading - automatically create a side group for long-form content delivery. Use when user requests content to be sent to a new group, or when generated content is too long for the current conversation (especially in voice mode). Keywords like "new group", "separate group", "side group", "new chat", "发到新群聊", "单独拉一个群", "创建群聊", "发到群里" trigger this skill.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Context Offloading

Create a dedicated side group for long-form content delivery, keeping the main conversation clean and concise.

## When to Offload

### Explicit Intent (User explicitly requests a separate group)

Detect when the user wants content delivered to a new group. Trigger phrases include:

| Language | Example Phrases |
|----------|----------------|
| English | "send to a new group", "create a group for this", "put it in a separate chat", "make a new group" |
| Chinese | "发到新群聊", "单独拉一个群", "创建群聊", "发到群里", "建个群", "拉个群" |

### Implicit Intent (Long content that should be offloaded)

Offload automatically when **ALL** of these conditions are met:
1. Generated content exceeds **2000 characters** (code blocks, config files, documentation)
2. Content is **not a direct answer** to a quick question (e.g., "what is X?")
3. The content is **structured deliverable** (code, config, report, multi-file output)

**Do NOT offload** when:
- The user asks a simple question with a short answer
- The content is conversational or explanatory (not a deliverable)
- The user has not been introduced to the offloading feature before

## Offloading Flow

### Step 1: Create Side Group

Run the group creation script:

```bash
SIDE_GROUP_NAME="Descriptive Name" \
SIDE_GROUP_MEMBERS='["ou_xxx"]' \
SIDE_GROUP_PARENT_CHAT_ID="oc_current_chat" \
npx tsx skills/context-offloading/create-side-group.ts
```

**Parameters:**
- `SIDE_GROUP_NAME` (required): A descriptive name for the side group (max 64 chars, auto-truncated)
- `SIDE_GROUP_MEMBERS` (required): JSON array of Feishu open IDs to invite (e.g., `["ou_xxx"]`)
- `SIDE_GROUP_PARENT_CHAT_ID` (optional): The current chat ID, stored as metadata

**Output:**
- On success: `OK: <new_chat_id>` (the Feishu chat ID of the new group, `oc_xxx` format)
- On failure: `ERROR: <reason>` with exit code 1

### Step 2: Deliver Content to Side Group

Use the existing MCP tools to send content to the new group:

- **Code blocks & text**: `send_text` tool with `chatId` = new group's chat ID
- **Formatted content**: `send_card` tool for structured presentations
- **Files**: `send_file` tool for file attachments

For multi-file deliverables, send each file/section as a separate message for readability.

### Step 3: Register for Lifecycle Management (Optional)

If the side group should be temporary (auto-expire after inactivity):

```json
{
  "chatId": "oc_new_group_id",
  "expiresAt": "2026-04-18T10:00:00.000Z",
  "creatorChatId": "oc_original_chat_id",
  "context": { "type": "context-offload", "parentChatId": "oc_original_chat_id" }
}
```

Use the `register_temp_chat` MCP tool to register the side group for automatic lifecycle management.

**Default expiry**: 24 hours. Use longer expiry for persistent deliverables.

### Step 4: Notify User in Main Chat

Reply in the main conversation with a **brief summary** (not the full content):

**Good notification:**
> "Done! Created group **[Group Name]** with the full content. Check the new group for details."

**Bad notification (do NOT repeat the content):**
> "Done! Here's the code: [200 lines of code]... and also sent to the group."

Keep the main chat response under 3 sentences. Include:
1. Confirmation that the group was created
2. A brief summary of what was delivered (1-2 sentences)
3. Direction to check the new group for details

## Group Naming Convention

Generate descriptive names from context:

| Content Type | Name Pattern | Example |
|-------------|-------------|---------|
| Code generation | `{Topic} - Code` | "LiteLLM Config - Code" |
| Report / Analysis | `{Topic} - Report` | "Q1 Sales - Report" |
| Multi-file config | `{Topic} - Config` | "Docker Setup - Config" |
| Research | `{Topic} - Research` | "React Patterns - Research" |
| General | `{Topic} - {Date}` | "Project Notes - 04/17" |

Keep names concise (max 64 chars). Include the date when relevant.

## Important Notes

- **English prompts only** in skill logic. Chinese phrases are for intent detection only.
- **Never offload without creating a group first.** If group creation fails, deliver content in the main chat as fallback.
- **Always invite the requesting user.** Use their open_id from the current message context.
- **One group per request.** Do not reuse groups across unrelated requests.
- **Voice mode priority.** In voice interactions, always prefer offloading long content to keep TTS output short.

## Example: Full Offloading Session

### User Request
> "Generate a complete LiteLLM configuration with proxy setup, and send it to a new group"

### Agent Actions

1. **Create side group:**
```bash
SIDE_GROUP_NAME="LiteLLM Config - Code" \
SIDE_GROUP_MEMBERS='["ou_user123"]' \
SIDE_GROUP_PARENT_CHAT_ID="oc_current_chat" \
npx tsx skills/context-offloading/create-side-group.ts
# Output: OK: oc_new_group_abc
```

2. **Send content to side group** (using `send_text` tool):
```
chatId: oc_new_group_abc
text: |
  ## LiteLLM Configuration

  Here are the 3 files for the LiteLLM proxy setup:

  ### 1. config.yaml
  ```yaml
  ... full config ...
  ```

  ### 2. custom_callbacks.py
  ```python
  ... full code ...
  ```
```

3. **Reply in main chat:**
> "Done! Created group **LiteLLM Config - Code** with all 3 configuration files. Check the new group for the complete setup."

## Error Handling

| Scenario | Action |
|----------|--------|
| Group creation fails | Fall back to delivering content in main chat. Report: "Could not create a new group. Sending content here instead." |
| User not invited | Retry invitation. If still fails, warn: "Created the group but could not invite you. Please join manually." |
| Content too long for one message | Split into multiple `send_text` calls to the side group |
| lark-cli not available | Fall back to main chat delivery. Report the error. |

## DO NOT

- **Never** put full content in both main chat AND side group. Main chat gets summary only.
- **Never** create a group without user intent (explicit or implicit).
- **Never** leave the user without a response in the main chat while creating the group.
- **Never** reuse a side group for unrelated requests. Create a new one each time.
