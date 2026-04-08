---
name: start-discussion
description: Non-blocking offline discussion initiator - detects topics needing user discussion, creates temporary group chats, and spawns Chat Agents. Use when user says keywords like "发起讨论", "离线提问", "offline discussion", "start discussion", "讨论群", or when detecting patterns like repeated commands, implicit complaints, costly work decisions, or topics needing stakeholder input. Also supports direct invocation via /start-discussion.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Start Discussion

Non-blocking discussion initiator that creates dedicated group chats for topics requiring user input, without interrupting the Agent's current workflow.

## Core Principle

**Prompt-based orchestration using existing chat infrastructure.** This skill does NOT implement group management — it delegates to the proven `chat` skill + `chats-activation` Schedule + `chat-timeout` pipeline.

## Single Responsibility

- ✅ Detect when a discussion is needed
- ✅ Create pending chat files via `scripts/chat/create.ts`
- ✅ Send discussion context to activated groups
- ✅ Poll for user responses and execute follow-up actions
- ❌ DO NOT create groups directly (handled by `chats-activation` Schedule via lark-cli)
- ❌ DO NOT dissolve groups (handled by `chat-timeout` skill)
- ❌ DO NOT send messages via MCP (consumer's responsibility, use `send_text`/`send_interactive`)

## When to Trigger

### Auto-Detection Patterns

This skill should be triggered when any of these patterns are detected:

| Pattern | Signal | Example |
|---------|--------|---------|
| **Repeated commands** | User gives same/similar instruction 3+ times | Same question asked in different ways |
| **Multi-step corrections** | User repeatedly corrects Agent's output | "No, not that way... try again" |
| **Implicit complaints** | User expresses frustration or dissatisfaction | "This keeps happening", "Why is it so slow" |
| **Costly decision** | Action that requires significant resources or is irreversible | Deleting data, large refactors, deployment |
| **Ambiguous requirement** | Task has multiple valid interpretations | "Fix the performance" (which part?) |
| **Stakeholder input needed** | Decision requires input from multiple people | Architecture choices, priority calls |
| **Explicit request** | User directly asks to start a discussion | "/start-discussion Should we migrate to X?" |

### Direct Invocation

```
/start-discussion [topic description]
```

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Three-Step Discussion Workflow

This skill implements the owner's 3-step vision (from Issue #631):

### Step 1: Detect & Create Discussion Group

Analyze context and create a temporary group chat for the discussion topic.

#### 1.1 Analyze Discussion Topic

If triggered by auto-detection (not explicit user request):
1. Read recent chat history: `cat workspace/chat/{chatId}.md | tail -100`
2. Summarize the topic requiring discussion
3. Identify which users should be invited

If triggered by explicit user request:
1. Use the provided topic description directly
2. Invite the requesting user (and relevant stakeholders if mentioned)

#### 1.2 Create Pending Chat

Use the existing `chat` infrastructure to create a pending chat file:

```bash
CHAT_ID="discussion-{unique-id}" \
CHAT_EXPIRES_AT="{iso-8601-z-suffix-timestamp}" \
CHAT_GROUP_NAME="{topic-summary}" \
CHAT_MEMBERS='["ou_requesting_user"]' \
CHAT_CONTEXT='{
  "source": "start-discussion",
  "triggeredBy": "auto|user",
  "originalChatId": "{chatId}",
  "topic": "{topic-summary}",
  "followUpActions": []
}' \
npx tsx scripts/chat/create.ts
```

**Important**:
- `CHAT_ID` must be unique: use `discussion-{timestamp}` or `discussion-{descriptive-slug}`
- `CHAT_EXPIRES_AT` should be 60 minutes from now (ISO 8601 Z-suffix)
- `CHAT_GROUP_NAME` should concisely describe the topic (max 64 chars, will be truncated)
- `CHAT_MEMBERS` must include at least the user who triggered the discussion
- `CHAT_CONTEXT.source` must be `"start-discussion"` for identification

#### 1.3 Return Immediately (Non-Blocking)

After creating the pending chat, **return immediately** to the caller. Do NOT wait for group activation.

Response format:
```
✅ Discussion created: {topic-summary}

📋 Chat ID: discussion-{id}
⏳ Status: Pending (group will be created automatically by chats-activation Schedule)
👥 Members: {member-list}
⏰ Expires: {expiresAt}

The discussion group will be created automatically. You will be notified once it's ready.
```

### Step 2: Send Discussion Context (When Group Activates)

This step is executed when the Agent detects the chat has been activated (status changed from `pending` to `active`).

#### 2.1 Check Activation Status

Poll the chat file to check if the group has been created:

```bash
CHAT_ID="discussion-{id}" npx tsx scripts/chat/query.ts
```

Look for `status: "active"` and a non-null `chatId` field.

#### 2.2 Send Discussion Content

Once activated, send the discussion context to the group:

Use `send_text` MCP tool with the following structure:

```markdown
## 📋 Discussion: {topic-summary}

**Context**: {why this discussion was initiated}

**Background**: {relevant information, logs, or data that led to this discussion}

**Questions for discussion**:
1. {question 1}
2. {question 2}
3. {question 3}

**Possible actions**:
- Option A: {description}
- Option B: {description}
- Option C: {other suggestions welcome}

---
💬 Please respond with your preference or suggestions.
⏰ This discussion expires in {remaining time}.
```

### Step 3: Execute Follow-Up Actions (When User Responds)

#### 3.1 Poll for Response

Check the chat file for user responses:

```bash
CHAT_ID="discussion-{id}" npx tsx scripts/chat/query.ts
```

Look for a non-null `response` field.

#### 3.2 Execute Follow-Up Actions

Based on the user's response and the `followUpActions` in the chat context, execute the appropriate action:

| Response Type | Follow-Up Action |
|---------------|-----------------|
| "Create a skill" | Invoke `skill-creator` skill |
| "Add a schedule" | Create schedule file in `schedules/` |
| "Start doing X" | Execute the requested task immediately |
| "Not needed" | Close the discussion (mark as expired) |
| Custom | Execute as specified in the response |

#### 3.3 Report Results

After executing follow-up actions, report back to the original chat:

```
✅ Discussion #{id} completed

📋 Topic: {topic}
💬 Decision: {user's response summary}
🔄 Action taken: {what was done}

Discussion group has been cleaned up.
```

---

## Follow-Up Action Patterns

### Pattern A: Create a New Skill

When the discussion concludes that a new skill is needed:

```
User response: "We need a skill for X"
→ Invoke skill-creator with the discussion context
→ Report skill creation result back to original chat
```

### Pattern B: Create a Scheduled Task

When the discussion concludes that a recurring task is needed:

```
User response: "This should run daily"
→ Create schedule file in schedules/
→ Report schedule creation result back to original chat
```

### Pattern C: Immediate Execution

When the discussion concludes with a specific action:

```
User response: "Go ahead and do X"
→ Execute the requested action immediately
→ Report execution result back to original chat
```

### Pattern D: No Action Needed

When the discussion concludes that no action is needed:

```
User response: "Never mind, not needed"
→ Mark the discussion as expired
→ Clean up
```

---

## Chat File Convention

For easy identification, all chats created by this skill:
- **ID prefix**: `discussion-` (e.g., `discussion-20260408-pr-review`, `discussion-20260408-perf`)
- **Context.source**: Always `"start-discussion"`
- **Context.originalChatId**: The chat where the discussion was initiated
- **Context.topic**: Human-readable topic summary

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Chat creation fails | Report error to user, suggest retrying |
| Group activation fails (status=failed) | Report error, check `lastActivationError` |
| Group activation times out (> 5 min) | Report timeout, suggest manual intervention |
| User doesn't respond before expiry | Discussion auto-expires, no follow-up |
| Follow-up action fails | Report failure, suggest manual retry |
| Duplicate chat ID | Use a different ID with additional suffix |

---

## Integration with Existing Infrastructure

| Component | Role | Managed By |
|-----------|------|------------|
| `scripts/chat/create.ts` | Create pending chat file | This Skill (Step 1) |
| `chats-activation` Schedule | Create group via lark-cli | Automatic (every minute) |
| `scripts/chat/query.ts` | Check chat status | This Skill (Steps 2, 3) |
| `send_text` MCP tool | Send messages to group | This Skill (Step 2) |
| `chat-timeout` Skill | Expire and dissolve groups | Automatic (every 5 min) |

---

## DO NOT

- ❌ Create groups directly (use `scripts/chat/create.ts`, Schedule handles group creation)
- ❌ Dissolve groups (handled by `chat-timeout` skill)
- ❌ Block waiting for group activation (return immediately after creating chat file)
- ❌ Send messages before the group is activated (check status first)
- ❌ Execute follow-up actions without user response (wait for explicit user input)
- ❌ Create discussions without a clear topic or purpose
- ❌ Include sensitive information in group names or context
- ❌ Modify the chat infrastructure scripts

---

## Example: Auto-Detected Discussion

### Trigger: Repeated Commands

**Chat History** (last 10 messages):
```
User: Fix the auth bug
Agent: I'll fix the auth bug...
User: No, I meant the login auth, not the API auth
Agent: Let me fix the login auth...
User: Wait, actually it's the OAuth flow that's broken
Agent: I'll fix the OAuth flow...
```

**Agent Action**:
1. Detects pattern: 3+ corrections on the same topic
2. Creates discussion: "Auth bug clarification needed"
3. Sends context to discussion group with all 3 interpretations
4. Waits for user to clarify which auth issue they mean
5. Once clarified, executes the correct fix

### Trigger: Costly Decision

**Chat History**:
```
Agent: I need to delete 500+ test files to clean up the repo. Proceeding...
```

**Agent Action**:
1. Detects pattern: Irreversible action affecting many files
2. Creates discussion: "Confirm: Delete 500+ test files?"
3. Sends context with list of affected files and rationale
4. Waits for explicit user approval before proceeding

---

## Example: Explicit User Request

### Input
```
/start-discussion Should we switch from REST to GraphQL for the API layer?
```

### Agent Action
1. Uses the provided topic directly
2. Creates pending chat with inviting user
3. Returns immediately: "✅ Discussion created: REST vs GraphQL API migration"
4. Once activated, sends pros/cons analysis to the group
5. Waits for user's decision
6. Executes chosen approach
