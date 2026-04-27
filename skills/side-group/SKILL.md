---
name: side-group
description: Create a side group chat for long-form content delivery, keeping the main conversation clean. Use when user says keywords like "发到新群聊", "单独拉一个群", "创建群聊", "side group", "offload content", "长内容发到新群". Also triggers when the agent generates content exceeding a threshold (e.g. >2000 chars) and the user is in voice mode, or when the user explicitly requests content be delivered to a separate group.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Side Group

Create a side group for delivering long-form content, keeping the main conversation clean.

## Single Responsibility

- ✅ Create a new Feishu group via lark-cli
- ✅ Invite specified members (and optionally the current user) to the group
- ✅ Send structured long-form content to the side group
- ✅ Return the group chat ID and name to the caller for main-chat notification
- ✅ Use the existing `chat` skill lifecycle for group management (timeout, cleanup)
- ❌ DO NOT determine content threshold automatically (the agent/caller decides)
- ❌ DO NOT send messages to the main chat (the agent handles that)
- ❌ DO NOT manage group lifecycle (handled by `chat-timeout` schedule)
- ❌ DO NOT use IPC Channel for group operations (use lark-cli directly)

## Invocation

This skill is invoked by the agent when:
1. **Explicit request**: User says "发到新群聊", "单独拉一个群", "创建群聊"
2. **Voice mode offloading**: Content exceeds ~2000 chars and user is in voice mode
3. **Artifact delivery**: Agent generates code, configs, or reports that benefit from a dedicated group

### Usage

```bash
SIDE_GROUP_NAME="LiteLLM 配置方案" \
SIDE_GROUP_MEMBERS='["ou_xxx"]' \
SIDE_GROUP_CONTEXT='{"source": "main-chat", "topic": "LiteLLM config"}' \
SIDE_GROUP_EXPIRES_AT="2026-04-28T10:00:00Z" \
npx tsx skills/side-group/side-group.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SIDE_GROUP_NAME` | Yes | Group display name (max 64 chars, auto-truncated) |
| `SIDE_GROUP_MEMBERS` | Yes | JSON array of member open IDs to invite |
| `SIDE_GROUP_CONTEXT` | No | JSON object stored in chat file for consumer use (default: `{}`) |
| `SIDE_GROUP_EXPIRES_AT` | No | ISO 8601 Z-suffix expiry timestamp (default: 24h from now) |
| `SIDE_GROUP_SKIP_LARK` | No | Set to '1' to skip lark-cli check and API call (testing only) |

### Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

Use the Sender Open ID as a member to invite.

## Execution Flow

```
1. Validate inputs (name, members, optional context)
2. Generate a unique chat ID (side-{timestamp}-{short-hash})
3. Create a pending chat file via the chat skill (workspace/chats/)
4. chats-activation schedule picks up the pending chat
5. Schedule creates group via lark-cli, updates status to active
6. Return the chat ID and group name to the agent
7. Agent sends content to the group once activated
8. chat-timeout schedule handles group cleanup when expired
```

## Group Naming Convention

Auto-generate names from context when possible:
- Code generation: "Code: {topic} - {date}"
- Reports: "Report: {topic} - {date}"
- Config: "Config: {topic} - {date}"
- Generic: "{topic} - {date}"

Date format: `MM/DD` (e.g., "04/27")

## Integration with Existing Features

| Feature | Relationship |
|---------|-------------|
| `chat` skill | Reuses chat file creation (`/chat create` pattern) |
| `chats-activation` schedule | Automatically activates pending chats (creates groups) |
| `chat-timeout` skill | Automatically expires and dissolves groups |
| `chats-cleanup` schedule | Cleans up stale lock files |

## Example: Agent Workflow

```
User: "生成 LiteLLM 配置方案，发到新群聊里"

Agent:
1. Invokes side-group skill → creates pending chat
2. Waits for activation (chats-activation creates the group)
3. Sends content to the new group
4. Replies in main chat: "✅ 已创建群聊「LiteLLM 配置方案」，内容已发送"
```

## Architecture

Group operations follow the same pattern as other skills:
- **Group creation**: Via `chat` skill + `chats-activation` schedule (lark-cli)
- **Group dissolution**: Via `chat-timeout` skill (lark-cli)
- **Content delivery**: Agent sends content after group is activated

This skill is a thin orchestration layer that:
1. Generates a deterministic chat ID
2. Creates a chat file using the `chat` skill's create script
3. Returns metadata for the agent to use

## Safety Guarantees

- **Input validation**: Name and members validated (same as `chat` skill)
- **Unique IDs**: Timestamp + hash prevents collisions
- **Lifecycle managed**: Groups auto-expire via chat-timeout
- **No orphaned groups**: chats-activation handles creation, chat-timeout handles cleanup
