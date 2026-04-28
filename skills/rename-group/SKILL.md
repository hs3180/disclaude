---
name: rename-group
description: Rename a Feishu group chat to match a task topic. Use when the bot is added to a group, receives a task, and needs to update the group name to reflect the task. Keywords: "rename group", "改群名", "修改群名称", "重命名群组".
allowed-tools: [Bash]
---

# Rename Group

Rename a Feishu group chat via lark-cli direct API call.

## Single Responsibility

- ✅ Rename a Feishu group to a given name
- ✅ Validate chat ID (oc_xxx format) and group name
- ✅ Truncate long names to 64 characters
- ❌ DO NOT use IPC Channel for group operations
- ❌ DO NOT create or dissolve groups
- ❌ DO NOT determine the name automatically (the agent decides the name)

## Invocation

This skill is invoked by the agent after understanding the user's task in a group chat. The agent determines an appropriate group name based on the task content.

### Usage

```bash
RENAME_CHAT_ID="oc_xxxxx" \
RENAME_GROUP_NAME="新群名" \
npx tsx skills/rename-group/rename-group.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RENAME_CHAT_ID` | Yes | Feishu group chat ID (oc_xxx format) |
| `RENAME_GROUP_NAME` | Yes | New name for the group (max 64 chars, auto-truncated) |
| `RENAME_SKIP_LARK` | No | Set to '1' to skip lark-cli check (testing only) |

### Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)

Use the Chat ID as `RENAME_CHAT_ID`.

## Execution Flow

```
1. Validate RENAME_CHAT_ID (must be oc_xxx format)
2. Validate RENAME_GROUP_NAME (non-empty, no control chars)
3. Truncate name to 64 characters if needed
4. Check lark-cli availability
5. Call lark-cli api PUT /open-apis/im/v1/chats/{chatId} -d '{"name":"..."}'
6. Report success or failure
```

## When to Use

1. **Bot added to group + given a task**: After the user describes the task, generate a concise group name summarizing the task and invoke this skill.
2. **Name guidelines**:
   - Keep it concise (max 64 chars, auto-truncated)
   - Use the format: "[topic]的[task type]" or a clear task summary
   - Examples: "需求分析", "PR #123 Review", "周报生成", "Bug修复讨论"

## Architecture

Group operations (rename, create, dissolve) use **lark-cli** to call Feishu API directly — NOT through IPC Channel.

## Safety Guarantees

- **Input validation**: Chat ID must match `oc_xxx` format, name must be non-empty
- **Name truncation**: Names exceeding 64 chars are truncated at character boundaries (CJK-safe)
- **Idempotent**: Renaming to the same name is safe (Feishu API handles this gracefully)
- **No IPC**: Direct lark-cli call, no worker→primary message passing
