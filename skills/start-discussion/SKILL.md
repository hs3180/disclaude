---
name: start-discussion
description: Non-blocking offline discussion initiator - composes atomic MCP tools (create_chat + send_text/send_interactive) to start discussions in group chats without blocking current work. Use when needing to initiate a discussion topic with users, create a discussion group, or leave a message for later discussion. Keywords: "发起讨论", "离线讨论", "留言", "start discussion", "leave note", "讨论群", "非阻塞".
allowed-tools: [send_text, send_interactive, create_chat, dissolve_chat, Read, Glob, Grep, Bash]
---

# Start Discussion

Non-blocking offline discussion initiator. Composes atomic MCP tools to start discussions in group chats without blocking current work.

## When to Use This Skill

**Use this skill when:**
- You identify a topic that needs user discussion but shouldn't block your current task
- You detect repeated user commands, corrections, or implicit complaints that deserve a dedicated discussion
- You want to leave a message for users to discuss asynchronously
- A decision needs input from multiple users before proceeding
- You want to share findings or questions that don't require immediate action

**Keywords that trigger this skill**: "发起讨论", "离线讨论", "留言", "start discussion", "leave note", "讨论群", "非阻塞", "讨论一下"

## Core Principle

**This skill is an orchestration guide, NOT a composite MCP tool.**

It composes existing atomic MCP tools following the Single Responsibility Principle:
- `create_chat` — atomic tool for creating group chats
- `send_text` — atomic tool for sending text messages
- `send_interactive` — atomic tool for sending interactive cards with buttons

> Issue #1298: Business logic (like starting a discussion) is NOT MCP scope. MCP tools expose atomic capabilities; orchestration is done by the Agent.

## Context Variables

When invoked, you receive:
- **Chat ID**: Current chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Discussion Workflow

### Step 1: Decide Discussion Mode

Choose based on context:

| Mode | When to Use | Tools Used |
|------|-------------|------------|
| **Use existing chat** | There's already a relevant group | `send_text` or `send_interactive` |
| **Create new chat** | Topic needs a dedicated space | `create_chat` + `send_text` or `send_interactive` |

**Decision criteria:**
- Is there already a group chat about this topic? → Use existing chat
- Does this topic need a dedicated, focused discussion? → Create new chat
- Is this a quick FYI or question? → Send to current chat

### Step 2: Prepare Context Prompt

Package your discussion context into a clear, structured prompt. The context should help the ChatAgent understand what to discuss with users.

**Context Prompt Template:**
```markdown
## Discussion: {topic}

### Background
{Why this discussion is needed}

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
- Be concise but informative — ChatAgent needs enough context to facilitate discussion
- Frame questions as open-ended to encourage user participation
- Include relevant data or findings that inform the discussion
- Suggest concrete actions so the discussion has clear outcomes

### Step 3A: Send to Existing Chat

Use `send_text` for simple messages:
```
send_text({
  text: "{context_prompt}",
  chatId: "{target_chat_id}"
})
```

Or use `send_interactive` for structured discussions with action buttons:
```
send_interactive({
  question: "{discussion_topic}",
  options: [
    { text: "Option A", value: "action_a", type: "primary" },
    { text: "Option B", value: "action_b" },
    { text: "Skip for now", value: "skip" }
  ],
  title: "{discussion_title}",
  context: "{background_context}",
  chatId: "{target_chat_id}",
  actionPrompts: {
    "action_a": "[User Action] User chose Option A: {detailed prompt}",
    "action_b": "[User Action] User chose Option B: {detailed prompt}",
    "skip": "[User Action] User chose to skip this discussion"
  }
})
```

### Step 3B: Create New Chat + Send

Use `create_chat` first, then send:
```
create_chat({
  name: "{discussion_topic}",
  description: "{brief_description}",
  memberIds: ["{member_open_id_1}", "{member_open_id_2}"]
})
```

Then use the returned `chatId` to send the context:
```
send_text({
  text: "{context_prompt}",
  chatId: "{returned_chat_id}"
})
```

### Step 4: Return Immediately

**This is a non-blocking operation.** After sending the discussion message:
- Return control to your current task immediately
- Do NOT wait for user responses
- The discussion continues asynchronously in the target chat
- User responses will trigger new agent sessions in that chat context

---

## Usage Scenarios

### Scenario 1: Repeated User Corrections

**Context**: You notice the user has corrected you on the same topic 3 times.

**Action**: Create a discussion to understand the root cause.
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

**Action**: Use `send_interactive` to present options before proceeding.
```
send_interactive({
  question: "This refactoring will take ~20 min and modify 15 files. Should I proceed?",
  options: [
    { text: "Proceed", value: "proceed", type: "primary" },
    { text: "Discuss first", value: "discuss" },
    { text: "Defer to later", value: "defer" }
  ],
  title: "Resource-Intensive Task",
  context: "Refactoring message-handler.ts to use new file-utils API",
  chatId: "{current_chat_id}"
})
```

### Scenario 3: Feature Discovery

**Context**: During work, you discover a pattern that could benefit from a new skill or scheduled task.

**Action**: Start a discussion in a dedicated group to explore the idea.
```
create_chat({
  name: "Feature: Automated Daily Reports",
  description: "Discussion about automating daily report generation",
  memberIds: ["{stakeholder_ids}"]
})

send_text({
  text: "## Discussion: Automated Daily Reports\n\n### Observation\nI've noticed we generate similar reports manually 3-4 times per week.\n\n### Proposal\nCreate a daily-chat-review scheduled task that auto-generates and sends reports.\n\n### Questions\n1. What reports do you need daily?\n2. What time should they be sent?\n3. Any specific format requirements?",
  chatId: "{new_chat_id}"
})
```

### Scenario 4: Post-Task Follow-up

**Context**: You completed a task and identified potential improvements.

**Action**: Send a structured follow-up with action buttons to the relevant chat.
```
send_interactive({
  question: "Task completed. I found some potential improvements during implementation.",
  options: [
    { text: "Create improvement issues", value: "create_issues", type: "primary" },
    { text: "Review findings", value: "review" },
    { text: "No action needed", value: "dismiss" }
  ],
  title: "Post-Task: Improvement Opportunities",
  context: "Found 3 optimization opportunities while implementing Issue #123",
  chatId: "{target_chat_id}"
})
```

---

## Integration with Other Skills

- **daily-chat-review**: Identifies discussion-worthy topics from chat analysis
- **next-step**: Recommends follow-up actions, which may include starting discussions
- **schedule**: Can trigger this skill on a schedule for recurring discussions
- **bbs-topic-initiator**: Specialized for BBS topic generation, a subset of discussion initiation

---

## Checklist

- [ ] Determined discussion mode (existing chat vs. new chat)
- [ ] Prepared structured context prompt
- [ ] Used atomic MCP tools (NOT a composite tool)
- [ ] Sent discussion message to target chat
- [ ] Returned immediately (non-blocking)
- [ ] Context prompt includes background, key points, and discussion questions

---

## DO NOT

- Create a composite MCP tool called `start_discussion` — use atomic tools
- Block and wait for user responses after sending
- Send discussions without proper context packaging
- Create unnecessary new chats when existing ones suffice
- Use `create_chat` for direct messages — only for group discussions
- Include sensitive information (credentials, tokens) in discussion context
