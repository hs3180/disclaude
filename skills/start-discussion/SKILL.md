---
name: start-discussion
description: Non-blocking discussion starter — creates a temporary group chat for focused discussion on a specific topic. Use when the agent identifies a discussion-worthy topic (repeated corrections, ambiguous requirements, potential improvements) and needs to involve users in a structured conversation. Keywords: "start discussion", "发起讨论", "讨论群", "讨论话题".
allowed-tools: [Bash, Read, Glob, Grep]
---

# Start Discussion

Create a non-blocking discussion group chat for a specific topic. The agent creates a pending chat file and returns immediately — the `chats-activation` Schedule will create the Feishu group automatically.

## Single Responsibility

- ✅ Create a discussion chat file with topic, members, and context
- ✅ Return the chat ID immediately (non-blocking)
- ✅ Guide the agent on follow-up steps (poll for activation, send context)
- ❌ DO NOT create groups directly (Schedule handles this via lark-cli)
- ❌ DO NOT send messages to groups (agent's responsibility after activation)
- ❌ DO NOT dissolve groups (handled by `chat-timeout` skill)
- ❌ DO NOT wait for user response (non-blocking by design)

## When to Use

The agent should start a discussion when it identifies a **discussion-worthy topic**:

| Signal | Example |
|--------|---------|
| Repeated corrections | User corrected the agent 3+ times on the same topic |
| Ambiguous requirements | "Should we use A or B?" — needs user input |
| Potential improvement | Agent noticed an optimization opportunity |
| User complaint | User expressed frustration about a workflow |
| Cost/benefit trade-off | "Is this expensive operation worth doing?" |

## Invocation

### Create Discussion

```bash
DISCUSSION_TOPIC="是否应该自动化代码格式化？" \
DISCUSSION_MEMBERS='["ou_user1", "ou_user2"]' \
DISCUSSION_CONTEXT='{"evidence": "User corrected formatting 5 times in past week"}' \
DISCUSSION_EXPIRES_HOURS=48 \
npx tsx skills/start-discussion/start-discussion.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCUSSION_TOPIC` | Yes | The discussion topic/question (max 64 chars for group name) |
| `DISCUSSION_MEMBERS` | Yes | JSON array of member open IDs (e.g. `'["ou_xxx","ou_yyy"]'`) |
| `DISCUSSION_CONTEXT` | No | JSON object with discussion context/materials for the ChatAgent |
| `DISCUSSION_EXPIRES_HOURS` | No | Hours until expiry (default: `24`, max: `168`/7 days) |
| `DISCUSSION_ID` | No | Custom chat ID (auto-generated as `discuss-{timestamp}` if not provided) |

### Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

Use the **Sender Open ID** as one of the discussion members if they should participate.

## Workflow

```
Step 1: Agent identifies a discussion-worthy topic
    ↓
Step 2: Invoke this skill → creates pending chat file
    ↓  (returns immediately — chat ID printed to stdout)
Step 3: chats-activation Schedule creates Feishu group (within 1 minute)
    ↓
Step 4: Agent polls chat file → detects status = "active"
    ↓
Step 5: Agent sends discussion context to group via MCP (send_text / send_interactive)
    ↓
Step 6: ChatAgent discusses with user in the group
    ↓
Step 7: Agent polls chat file → detects response
    ↓
Step 8: Agent processes response and takes follow-up action
```

### Follow-up: Poll for Activation

After creating the discussion, check if the group has been activated:

```bash
CHAT_ID="discuss-1713990000000" npx tsx skills/chat/query.ts
```

When `status` changes to `"active"`, the group has been created and the `chatId` field contains the Feishu group ID.

### Follow-up: Send Context to Group

Once active, send the discussion context to the ChatAgent in the group. Use the `chatId` from the chat file:

- Use `send_text` or `send_interactive` MCP tools to send the initial message
- Include the discussion topic, relevant context, and what kind of input is needed
- The ChatAgent in the group will use this to guide the discussion

### Follow-up: Check for Response

```bash
CHAT_ID="discuss-1713990000000" npx tsx skills/chat/query.ts
```

When the `response` field is populated, the user has replied. Process the response and take appropriate action.

## Output Format

On success, the script outputs:
```
OK: Discussion discuss-{id} created
CHAT_ID: discuss-{id}
```

The agent should extract the `CHAT_ID` value for follow-up polling.

## Discussion Context Best Practices

When preparing the `DISCUSSION_CONTEXT`, include:

1. **Why this discussion is needed** — What triggered it
2. **Relevant evidence** — Data, patterns, or observations supporting the discussion
3. **What input is needed** — Decision, feedback, preference, etc.
4. **Constraints or preferences** — Known limitations or user preferences

Example:
```json
{
  "trigger": "User corrected output format 5 times this week",
  "evidence": "Corrections were about code block formatting in PR review messages",
  "question": "Should we switch to a different output format template?",
  "options": ["Keep current format", "Use simplified format", "Make format configurable"],
  "deadline": "End of sprint (Friday)"
}
```

## Architecture

This skill follows the **Consumer pattern** used by PR Scanner and other chat consumers:

| Component | Role |
|-----------|------|
| **This skill** | Creates discussion chat file (consumer) |
| `chats-activation` Schedule | Creates Feishu group via lark-cli |
| `chat-timeout` skill | Dissolves group after expiry |
| Caller agent | Polls for activation, sends context, processes response |

Group operations use **lark-cli** (Feishu official CLI), NOT MCP tools:
- Group creation: `lark-cli im +chat-create` (via Schedule)
- Group dissolution: `lark-cli api DELETE /open-apis/im/v1/chats/{id}` (via chat-timeout)
- Message sending: MCP tools `send_text` / `send_interactive` (via agent)

## Error Handling

| Scenario | Action |
|----------|--------|
| Missing DISCUSSION_TOPIC | Report error, exit |
| Invalid member format | Report error (must be `ou_xxxxx`), exit |
| Invalid DISCUSSION_CONTEXT | Report error (must be valid JSON), exit |
| Duplicate DISCUSSION_ID | Report error, exit |
| Group creation fails | Schedule retries up to 5 times, then marks as `failed` |
| Chat expires before response | `chat-timeout` dissolves group |

## Related

- **Infrastructure**: `chat` skill (chat file management)
- **Activation**: `chats-activation` Schedule (group creation via lark-cli)
- **Timeout**: `chat-timeout` skill (group dissolution)
- **Discussion focus**: #1228 (SOUL.md discussion personality — future enhancement)
- **Parent Issue**: #631 (non-blocking discussion feature)
