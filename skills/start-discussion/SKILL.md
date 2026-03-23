---
name: start-discussion
description: Start an offline discussion in a dedicated group chat without blocking current work (Issue #631)
---

# Start Discussion Skill

## Context
- Source Chat ID: {sourceChatId}
- Topic: {topic}
- Description: {description}

## Single Responsibility
- ✅ Create a dedicated discussion group for the specified topic
- ✅ Send the initial discussion prompt to the new group
- ✅ Notify the source chat that a discussion has been started
- ❌ DO NOT participate in the discussion yourself (the ChatAgent in the new group will handle it)
- ❌ DO NOT block waiting for discussion results

## Background

This skill implements the "offline discussion" mechanism from Issue #631. When the agent detects a topic that needs user input or deeper exploration, it can start an asynchronous discussion without blocking its current work.

### When to Use This Skill

Start a discussion when you detect any of these patterns:
- User gives **repeated instructions** about the same topic
- User makes **multi-step corrections** suggesting confusion or disagreement
- User **explicitly or implicitly complains** about something
- A **significant work item** might not be worth doing and needs validation
- A **design decision** needs stakeholder input before proceeding

### Design Principles (from Issue #1298)

- Discussion creation is an **internal system operation**, not an MCP tool
- Business logic (when/why to discuss) stays in the skill layer
- The underlying group creation uses existing `chat-ops` and `GroupService`

## Workflow

### Step 1: Create Discussion Group

Use the system's internal discussion creation capability to create a new Feishu group:

1. Define the discussion topic clearly with:
   - **Title**: A concise topic name (will be used as group name)
   - **Description**: What needs to be discussed and why
   - **Context**: Any relevant background information
   - **Participants**: Users who should be involved

2. Create the discussion group and record its chat ID

### Step 2: Send Initial Discussion Message

Send an opening message to the newly created discussion group that:

1. States the discussion topic clearly
2. Provides relevant context and background
3. Poses specific questions for participants
4. Sets expectations for the discussion outcome

Message format example:
```
📋 **讨论主题**: {topic}

**背景**: {context/why this needs discussion}

**需要讨论的问题**:
1. {question 1}
2. {question 2}
3. {question 3}

**可能的后续行动**:
- 新增一个 skill
- 新增一个定时任务
- 立即开始某项工作
- 其他

请讨论并给出你们的意见。
```

### Step 3: Notify Source Chat

Send a notification to the original chat (sourceChatId) that a discussion has been started:

```
💬 已就「{topic}」发起异步讨论

讨论群已创建，相关用户已受邀参与讨论。
讨论完成后将根据结果执行后续行动。
```

### Step 4: Return Result

Return a summary of what was done:
- Discussion ID
- Discussion group chat ID
- Topic
- Participants invited

## Discussion Conclusion

When the discussion group reaches a conclusion (detected by the ChatAgent in that group), the following actions may be taken:

| Outcome | Action |
|---------|--------|
| **Consensus reached** | Execute agreed-upon follow-up actions |
| **Needs more info** | Defer and revisit later |
| **Not needed** | Cancel and close the discussion group |

## Output

Create a summary of the discussion creation:
- Whether the discussion was created successfully
- The discussion group chat ID
- Any errors encountered
