---
name: start-discussion
description: Start a non-blocking discussion in a temporary group chat. Use when the Agent identifies a topic that needs user discussion, such as repeated commands, implicit complaints, costly work decisions, or ambiguous requirements. Keywords: "发起讨论", "离线提问", "start discussion", "创建讨论群", "讨论一下".
allowed-tools: [Bash, Read, Glob, Grep]
---

# Start Discussion

Initiate a non-blocking group discussion on a topic that requires user input. The discussion happens asynchronously — the Agent creates the discussion and **immediately returns** to its current work.

## When to Use

Start a discussion when you observe any of these patterns:

- **Repeated commands**: User gives similar instructions multiple times (suggests unclear requirements)
- **Implicit complaints**: User expresses frustration or dissatisfaction indirectly
- **Costly decisions**: A planned action has significant impact (time, architecture, workflow)
- **Ambiguous requirements**: Multiple valid interpretations exist for a task
- **Proactive suggestions**: You identify an optimization or improvement worth discussing
- **Explicit request**: User directly asks to discuss a topic

## DO NOT Use

- ❌ Questions that can be answered with a single message (use `send_text` directly)
- ❌ Topics already under active discussion
- ❌ Purely informational updates (no discussion needed)
- ❌ Emergency issues requiring immediate action

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Workflow

### Step 1: Analyze the Discussion Topic

Before creating a discussion, clearly define:

1. **Topic**: What specific question or decision needs discussion?
2. **Background**: Why is this worth discussing? What evidence supports it?
3. **Suggested options** (optional): If you have recommendations, include them
4. **Action plan**: What will happen after the discussion concludes?

### Step 2: Create the Discussion Chat

Create a pending chat using the `chat` skill's infrastructure:

```bash
CHAT_ID="disc-<descriptive-slug>" \
CHAT_EXPIRES_AT="<24h from now in UTC Z-suffix>" \
CHAT_GROUP_NAME="<concise topic>" \
CHAT_MEMBERS='["<user_open_id>"]' \
CHAT_CONTEXT='{
  "type": "discussion",
  "topic": "<discussion topic>",
  "background": "<why this needs discussion>",
  "prompt": "<initial discussion message>",
  "suggestedOptions": ["<option1>", "<option2>"],
  "actionPlan": "<what happens after discussion>",
  "initiatedBy": "<agent or user identifier>",
  "sourceChatId": "<original chat ID>"
}' \
bash scripts/chat/create.sh
```

**Chat ID format**: `disc-<descriptive-slug>` (e.g., `disc-code-format-automation`, `disc-pr-review-456`)

**Important**:
- Always use `disc-` prefix to distinguish discussion chats from other chat types
- `CHAT_EXPIRES_AT` should be ~24 hours from now (format: `YYYY-MM-DDTHH:mm:ssZ`)
- Include the **source chat ID** in context so the discussion can report back
- Keep `CHAT_GROUP_NAME` concise (max 64 chars) — it becomes the Feishu group name

### Step 3: Return Immediately

After creating the chat file, **return to your current work immediately**. Do NOT:
- ❌ Wait for the group to be created
- ❌ Poll for chat activation
- ❌ Send messages to the group yourself

The `discussion-messenger` Schedule will handle:
1. Detecting when the chat becomes active (group created by `chats-activation`)
2. Sending the initial discussion prompt to the group
3. Notifying the original chat that a discussion has started

## Context Format Reference

The `CHAT_CONTEXT` JSON for discussion chats must follow this structure:

```json
{
  "type": "discussion",
  "topic": "是否应该自动化代码格式化？",
  "background": "用户在过去3次会话中手动运行 prettier，每次花费5-10分钟",
  "prompt": "我注意到你最近多次手动运行代码格式化。想讨论一下：我们是否应该设置自动格式化（如 pre-commit hook 或 CI check）？\n\n**选项**:\n1. 添加 pre-commit hook（本地自动格式化）\n2. 在 CI 中添加格式化检查\n3. 保持现状（手动格式化）\n4. 其他方案？",
  "suggestedOptions": [
    "添加 pre-commit hook",
    "CI 格式化检查",
    "保持现状"
  ],
  "actionPlan": "根据选择结果，配置相应的自动化工具",
  "initiatedBy": "issue-solver",
  "sourceChatId": "oc_71e5f41a029f3a120988b7ecb76df314"
}
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Must be `"discussion"` for the messenger to detect |
| `topic` | Yes | Short description of the discussion topic |
| `background` | Yes | Why this discussion is needed (evidence/reasoning) |
| `prompt` | Yes | The initial message to send to the group (Markdown supported) |
| `suggestedOptions` | No | Array of suggested options for the user to choose from |
| `actionPlan` | No | What action will be taken based on the discussion outcome |
| `initiatedBy` | No | Identifier of who/what initiated the discussion |
| `sourceChatId` | No | Original chat ID for sending back discussion results |

## Example

### Scenario: Agent detects repeated manual formatting

```
Agent observes: User has manually run prettier in 3 consecutive sessions.

Agent creates discussion:
  CHAT_ID="disc-code-format"
  CHAT_EXPIRES_AT="2026-04-05T10:00:00Z"
  CHAT_GROUP_NAME="讨论: 代码格式化自动化"
  CHAT_MEMBERS='["ou_abc123"]'
  CHAT_CONTEXT='{"type":"discussion","topic":"...","background":"...","prompt":"..."}'

Agent returns to current work immediately.
---
Later (automatic):
  chats-activation schedule → creates group → sets status to active
  discussion-messenger schedule → sends prompt to group → notifies source chat
---
User discusses in the new group.
```

## Relationship to Other Components

| Component | Responsibility |
|-----------|---------------|
| **This Skill** (`start-discussion`) | Create pending discussion chat files |
| **`chat` Skill** | Low-level chat file management (create/query/list/response) |
| **`chats-activation` Schedule** | Create groups via `lark-cli` (handles all pending chats) |
| **`discussion-messenger` Schedule** | Send initial prompts to active discussion groups |
| **`chat-timeout` Skill** | Dissolve expired groups and clean up |

## DO NOT

- ❌ Create groups directly (use `lark-cli` via `chats-activation` schedule)
- ❌ Send messages to groups (use `discussion-messenger` schedule)
- ❌ Wait for chat activation (return immediately after creating the file)
- ❌ Dissolve groups (use `chat-timeout` skill)
- ❌ Poll the chat file for responses (consumers handle this)
- ❌ Create discussions without a clear topic and background
- ❌ Use non-`disc-` prefixed chat IDs
