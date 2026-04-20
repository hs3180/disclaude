---
name: start-discussion
description: Initiate non-blocking offline discussions with users. Agent creates a temporary group, sends discussion context, and returns immediately — without blocking ongoing work. Use when user says keywords like "离线提问", "发起讨论", "讨论一下", "offline question", "start discussion", "ask user", "发起投票".
allowed-tools: [Bash, Read, send_text, send_interactive]
---

# Start Discussion — Non-blocking Offline Question

Initiate a non-blocking discussion with one or more users via temporary chat groups. The Agent creates a temporary group, sends the discussion context, and returns immediately. The user can respond at their convenience.

## When to Use This Skill

**Use this skill when:**
- The Agent identifies a topic needing deep human discussion (e.g., architecture decisions, repeated corrections, ambiguous requirements)
- The Agent needs user input but should NOT block current work
- The user explicitly asks to discuss something asynchronously ("讨论一下", "离线提问", "start discussion")
- The Agent detects user frustration or repeated corrections and wants to proactively gather feedback

**Do NOT use for:**
- Simple yes/no questions (use inline replies)
- Emergency blocking issues (use direct message)
- Topics that can be resolved with a quick search

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Core Principle

**Non-blocking by design.** This skill creates a temporary chat and returns immediately. The discussion happens asynchronously in the new group, without blocking the Agent's current work.

---

## Discussion Flow

### Step 1: Analyze the Discussion Topic

Before creating a chat, understand what needs to be discussed:

1. **Identify the topic** — What question or decision needs human input?
2. **Identify participants** — Who should be involved? (default: the current user via Sender Open ID)
3. **Formulate context** — Summarize the discussion background in 1-3 paragraphs
4. **Set expiry** — How long should we wait? (default: 24 hours from now)

### Step 2: Create Pending Chat

Create a temporary chat file using the existing `chat` skill infrastructure:

```bash
CHAT_ID="discuss-{topic-slug}" \
CHAT_EXPIRES_AT="2026-04-21T10:00:00Z" \
CHAT_GROUP_NAME="讨论: {topic summary}" \
CHAT_MEMBERS='["ou_xxx"]' \
CHAT_CONTEXT='{"topic": "architecture decision", "source": "offline-question"}' \
npx tsx skills/chat/create.ts
```

**Parameters:**
- `CHAT_ID`: Unique identifier — use format `discuss-{descriptive-slug}` (e.g., `discuss-auth-refactor`, `discuss-api-design`)
- `CHAT_EXPIRES_AT`: UTC Z-suffix ISO 8601 timestamp, typically 24 hours from now
- `CHAT_GROUP_NAME`: Short description of the discussion topic (max 64 chars)
- `CHAT_MEMBERS`: JSON array of open IDs. Default: current user's `Sender Open ID`
- `CHAT_CONTEXT`: Optional JSON object with discussion metadata

**If creation fails** (e.g., duplicate ID), generate a new unique ID and retry.

### Step 3: Wait for Activation

The `chats-activation` schedule will automatically create the group via `lark-cli`. Poll the chat file to detect activation:

```bash
CHAT_ID="discuss-{topic-slug}" npx tsx skills/chat/query.ts
```

**Polling strategy:**
1. Check once immediately after creation
2. If status is `pending`, report to user that the discussion group is being created
3. If status is `active`, proceed to Step 4
4. If status is `failed`, report the error and suggest retrying

**Typical activation time:** ~1 minute (schedule runs every minute).

### Step 4: Send Discussion Context

Once the chat is `active`, send the discussion context to the group using MCP tools.

**For simple text discussions:**
```
send_text({
  chatId: "{activated chatId from chat file}",
  message: "## Discussion Topic\n\n{context}\n\n---\nPlease share your thoughts."
})
```

**For structured discussions with options:**
```
send_interactive({
  chatId: "{activated chatId from chat file}",
  card: {
    "config": {"wide_screen_mode": true},
    "header": {
      "title": {"tag": "plain_text", "content": "Discussion: {topic}"},
      "template": "blue"
    },
    "elements": [
      {"tag": "markdown", "content": "{context}"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "Agree", "tag": "plain_text"}, "value": "agree", "type": "primary"},
        {"tag": "button", "text": {"content": "Need more info", "tag": "plain_text"}, "value": "need_info"},
        {"tag": "button", "text": {"content": "Disagree", "tag": "plain_text"}, "value": "disagree"}
      ]}
    ]
  }
})
```

### Step 5: Report Back (Non-blocking)

Report to the user in the original conversation that the discussion has been initiated:

```
Discussion created: {topic}
Group: {activated chatId}
Expires: {expiresAt}
Status: Waiting for response
```

**Then return immediately.** Do NOT block waiting for the response.

---

## Response Handling

After the user responds in the discussion group, the response is recorded in the chat file. To check for responses:

```bash
CHAT_ID="discuss-{topic-slug}" npx tsx skills/chat/query.ts
```

The `response` field will contain the user's reply when available:

```json
{
  "response": {
    "content": "User's response text",
    "responder": "ou_developer",
    "repliedAt": "2026-04-20T14:30:00Z"
  }
}
```

**Downstream actions** based on response are the consumer's responsibility. Common patterns:
- Create a new skill based on user feedback
- Adjust current behavior based on the discussion result
- Schedule a follow-up task
- Create a GitHub issue or PR based on the decision

---

## Lifecycle Management

| Phase | Who Handles | How |
|-------|-------------|-----|
| Create chat file | **This Skill** | `chat/create.ts` |
| Create group | **chats-activation Schedule** | `lark-cli im +chat-create` |
| Send context | **This Skill** | `send_text` / `send_interactive` |
| Record response | **chat skill / consumer** | `chat/response.ts` |
| Timeout & dissolve | **chat-timeout Skill** | `lark-cli api DELETE ...` |
| Cleanup files | **chats-cleanup Schedule** | File deletion |

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Chat creation fails (duplicate ID) | Generate new unique ID and retry |
| Chat creation fails (validation) | Fix parameters and retry |
| Activation fails (status=failed) | Report error, suggest manual creation or retry |
| Activation timeout (> 5 min) | Inform user of delay, suggest checking lark-cli availability |
| Send fails | Retry sending once. If still fails, report error |
| No response before expiry | chat-timeout skill handles dissolution automatically |

---

## Examples

### Example 1: Architecture Decision

**Trigger**: Agent identifies an ambiguous architecture choice while working on a feature.

1. Agent creates: `CHAT_ID="discuss-auth-strategy"`, `CHAT_GROUP_NAME="讨论: Auth策略选择"`
2. Schedule activates, creates group
3. Agent sends via `send_interactive`:
   ```
   ## Auth Strategy Decision

   We need to decide on the authentication approach:
   - Option A: JWT with refresh tokens
   - Option B: Session-based with cookies
   - Option C: OAuth2 proxy

   Trade-offs: [details]
   ```
4. Agent returns to original task

### Example 2: User Preference Gathering

**Trigger**: Agent notices user repeatedly correcting output format.

1. Agent creates: `CHAT_ID="discuss-output-format"`, `CHAT_GROUP_NAME="讨论: 输出格式偏好"`
2. Schedule activates
3. Agent sends via `send_text`:
   ```
   I noticed you've corrected the output format several times.
   Let's discuss your preferred format so I can adjust.
   ```
4. Agent continues current work

### Example 3: Proactive Feedback Collection

**Trigger**: User explicitly asks for offline discussion.

User: "帮我发起一个讨论，关于是否要引入新的测试框架"

1. Agent creates: `CHAT_ID="discuss-test-framework"`, `CHAT_GROUP_NAME="讨论: 测试框架选型"`
2. Schedule activates
3. Agent sends discussion context with pros/cons
4. Agent reports: "已创建讨论群，等待回复"

---

## DO NOT

- Block waiting for user response (this defeats the purpose of "offline")
- Create MCP tools for discussion management (use existing `chat` skill infrastructure)
- Bypass the `chat` skill and call `lark-cli` directly (let the schedule handle group creation)
- Create chats without an `expiresAt` (required field)
- Use non-UTC timestamps in `expiresAt`
- Delete chat files manually (let `chats-cleanup` schedule handle it)
- Send messages to the discussion group before it's activated (check status first)
