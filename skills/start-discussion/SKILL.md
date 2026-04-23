---
name: start-discussion
description: Non-blocking offline discussion initiator — creates a Feishu group via lark-cli, sends discussion context to the new group, and returns immediately without blocking current work. Use when needing to initiate a discussion topic with users, detect repeated corrections or complaints that deserve a dedicated discussion, or leave a message for asynchronous discussion. Keywords: "发起讨论", "离线讨论", "留言", "start discussion", "leave note", "讨论群", "非阻塞".
allowed-tools: [send_text, send_interactive, Bash, Read, Glob, Grep]
---

# Start Discussion

Non-blocking offline discussion initiator. Creates a Feishu group via `lark-cli` (Bash), sends discussion context via MCP messaging tools, and returns immediately.

## When to Use

**Use this skill when:**
- You identify a topic that needs user discussion but shouldn't block your current task
- You detect repeated user commands, corrections, or implicit complaints that deserve a dedicated discussion
- You want to leave a message for users to discuss asynchronously
- A decision needs input from multiple users before proceeding
- You discover a pattern that could benefit from a new skill, schedule, or process improvement

**Keywords that trigger this skill**: "发起讨论", "离线讨论", "留言", "start discussion", "leave note", "讨论群", "非阻塞", "讨论一下"

## Architecture

Group operations use **lark-cli** directly via Bash — NOT through MCP tools or IPC Channel. This follows the same pattern as:
- `chats-activation.ts` (group creation via lark-cli)
- `chat-timeout.ts` (group dissolution via lark-cli)
- `rename-group` skill (group rename via lark-cli)

Message sending uses MCP tools (`send_text`, `send_interactive`) which remain the correct path for message delivery.

```
Agent → Bash → lark-cli im +chat-create → Feishu API  (group creation)
Agent → send_text / send_interactive → Feishu API     (message delivery)
```

## Context Variables

When invoked, you receive:
- **Chat ID**: Current chat ID (from "**Chat ID:** xxx" in the message header)
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Discussion Workflow

### Step 1: Prepare Discussion Context

Package your discussion context into a clear, structured prompt. The context should help the ChatAgent (that will be spawned in the new group) understand what to discuss with users.

**Context Prompt Template:**
```markdown
## Discussion: {topic}

### Background
{Why this discussion is needed — what triggered it}

### Key Points
1. {Point 1}
2. {Point 2}

### Questions for Discussion
1. {Open-ended question 1}
2. {Open-ended question 2}

### Suggested Actions
- {Action option 1}
- {Action option 2}
```

**Context packaging guidelines:**
- Be concise but informative — the ChatAgent needs enough context to facilitate discussion
- Frame questions as open-ended to encourage user participation
- Include relevant data or findings that inform the discussion
- Suggest concrete actions so the discussion has clear outcomes

### Step 2: Create Discussion Group

Use `lark-cli` via Bash to create a new Feishu group chat:

```bash
lark-cli im +chat-create --name "{discussion_topic}" --users "{member_open_ids}"
```

**Parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `--name` | Yes | Group display name (max 64 chars, auto-truncated by lark-cli) |
| `--users` | Yes | Comma-separated open IDs of members to add (e.g., `ou_abc123,ou_def456`) |

**The agent MUST use the Sender Open ID from context variables as a member.** If additional stakeholders are known, include their open IDs as well.

**Expected output:** A JSON response containing `data.chat_id` — the new group's chat ID (format: `oc_xxxxx`).

**Error handling:**
- If lark-cli is not found: report the error and suggest installing `@larksuite/cli`
- If the API call fails: report the error message and do NOT proceed to Step 3

### Step 3: Send Discussion Context

After successfully creating the group, send the discussion context to the new group.

**For simple discussions**, use `send_text`:
```
send_text({
  text: "{context_prompt}",
  chatId: "{returned_chat_id}"
})
```

**For structured discussions with action buttons**, use `send_interactive`:
```
send_interactive({
  question: "{discussion_summary_question}",
  options: [
    { text: "Option A", value: "action_a", type: "primary" },
    { text: "Option B", value: "action_b" },
    { text: "Discuss later", value: "defer" }
  ],
  title: "{discussion_title}",
  context: "{background_context}",
  chatId: "{returned_chat_id}",
  actionPrompts: {
    "action_a": "[User Action] User chose Option A: {detailed prompt}",
    "action_b": "[User Action] User chose Option B: {detailed prompt}",
    "defer": "[User Action] User chose to defer this discussion"
  }
})
```

### Step 4: Return Immediately

**This is a non-blocking operation.** After sending the discussion message:
- Return control to your current task immediately
- Do NOT wait for user responses
- The discussion continues asynchronously in the new group
- User messages in the new group will trigger a new ChatAgent session with the discussion context

---

## Usage Scenarios

### Scenario 1: Repeated User Corrections

**Context**: You notice the user has corrected you on the same topic 3 times.

**Action**: Create a discussion to understand the root cause.

```bash
# Create group
lark-cli im +chat-create --name "输出格式讨论" --users "ou_sender123"

# Then send via send_text or send_interactive with discussion context
```

**Context prompt:**
```markdown
## Discussion: Output Format Corrections

### Background
In the last 3 sessions, I've been corrected about markdown table formatting. I'd like to discuss the preferred format to avoid future corrections.

### Questions
1. What is the preferred table format for reports?
2. Are there formatting guidelines I should follow?
3. Should I create a style guide skill?
```

### Scenario 2: Costly Decision

**Context**: A task will take significant resources (time, API calls, compute).

**Action**: Use `send_interactive` to present options in a dedicated group.

```bash
# Create group
lark-cli im +chat-create --name "重构方案讨论" --users "ou_sender123,ou_lead456"

# Then use send_interactive with action buttons
```

### Scenario 3: Feature Discovery

**Context**: During work, you discover a pattern that could benefit from a new skill or scheduled task.

**Action**: Start a discussion in a dedicated group to explore the idea.

```bash
# Create group
lark-cli im +chat-create --name "Feature: 自动日报" --users "ou_sender123"

# Then send discussion context
```

### Scenario 4: Post-Task Follow-up

**Context**: You completed a task and identified potential improvements.

**Action**: Send a structured follow-up with action buttons.

---

## Integration with Other Skills

| Skill | How it relates |
|-------|----------------|
| `daily-chat-review` | Identifies discussion-worthy topics from chat analysis |
| `next-step` | Recommends follow-up actions, which may include starting discussions |
| `bbs-topic-initiator` | Specialized for BBS topic generation, a subset of discussion initiation |
| `chat` | Manages structured request/response temp chats (different from free-form discussions) |

---

## DO NOT

- ❌ Use MCP tools `create_chat` / `dissolve_chat` — use `lark-cli` via Bash instead
- ❌ Block and wait for user responses after sending
- ❌ Send discussions without proper context packaging
- ❌ Include sensitive information (credentials, tokens) in discussion context
- ❌ Create groups with only the bot (must include at least one real user)
- ❌ Send empty or trivial discussion messages
