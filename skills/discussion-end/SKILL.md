---
name: discussion-end
description: Smart discussion lifecycle management - detects when a discussion has reached its conclusion and gracefully ends it by dissolving the group. Automatically activated when a discussion topic is set. Use when discussion reaches consensus, user requests to end, or no productive progress. Keywords: "讨论结束", "结束讨论", "discussion end", "close discussion", "dissolve group", "解散群".
user-invocable: false
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Discussion End Manager

Manages the lifecycle end of group discussions. Detects when a discussion has reached its natural conclusion and executes the group dissolution protocol.

## Single Responsibility

- Detect when a discussion should end (consensus, user request, timeout, abandonment)
- Send a structured summary message to the group
- Dissolve the group via `lark-cli`
- Handle dissolution errors gracefully

## Activation

This skill is **automatically activated** when:
- A discussion topic has been set (e.g., via `start-discussion` or `daily-soul-question`)
- The current chat is a temporary/group discussion context

## When to End a Discussion

End the discussion when **any** of the following conditions are met:

### 1. Consensus Reached
- The main question has been answered conclusively
- A clear decision has been made
- All participants agree on the outcome

### 2. User Explicitly Requests
- User says things like "够了", "可以了", "到此为止", "结束吧", "that's enough", "let's wrap up"
- User explicitly asks to close the discussion

### 3. No Productive Progress
- After 3+ exchanges with no new information or progress
- The conversation has drifted far from the original topic without returning
- Participants are repeating points already made

### 4. Timeout
- The discussion has exceeded a reasonable duration (use judgment based on topic complexity)

## End Protocol

When ending a discussion, follow these steps **in order**:

### Step 1: Send Summary Message

Send a final summary to the group. The summary MUST include the `[DISCUSSION_END]` trigger marker as the first line:

```
[DISCUSSION_END]

📋 讨论总结

**主题**: {original topic}
**结论**: {brief conclusion}
**关键要点**:
- Point 1
- Point 2
- Point 3

感谢参与！群聊将在片刻后自动解散。
```

The `[DISCUSSION_END]` marker serves as:
- A visual signal to all participants that the discussion is ending
- A structured trigger for any downstream automation
- A log marker for discussion lifecycle tracking

### Step 2: Dissolve the Group

After sending the summary, immediately dissolve the group using `lark-cli`:

```bash
lark-cli api DELETE /open-apis/im/v1/chats/{chat_id}
```

**Important**: Replace `{chat_id}` with the actual Feishu chat ID from the conversation context.

**Example**:
```bash
lark-cli api DELETE /open-apis/im/v1/chats/oc_71e5f41a029f3a120988b7ecb76df314
```

### Step 3: Verify Dissolution

Check the response from lark-cli:
- **Success** (`code: 0`): Group dissolved successfully. No further action needed.
- **Error**: Log the error but do NOT retry. Common errors:
  - `99991668` / `99991672`: Bot is not the group owner (only group owners can dissolve)
  - `99991663`: Chat does not exist or already dissolved
  - Network timeout: Group may or may not have been dissolved

## Trigger Phrase Variants

| Phrase | Meaning | When to Use |
|--------|---------|-------------|
| `[DISCUSSION_END]` | Normal conclusion | Consensus reached or user requested |
| `[DISCUSSION_END:timeout]` | Timeout | Discussion exceeded reasonable duration |
| `[DISCUSSION_END:abandoned]` | Abandoned | No productive progress after warnings |

### Timeout Handling

If the discussion is stalling, send a warning before dissolving:

```
⚠️ 讨论已进行较长时间，似乎没有新的进展。

如果还有要补充的，请继续发言。
如果没有，我将在下一轮回复后结束讨论并解散群聊。
```

If after this warning there is still no productive progress, proceed with `[DISCUSSION_END:timeout]`.

### Abandonment Handling

If the discussion has stalled completely (user hasn't responded meaningfully), you may proceed directly to dissolution without additional warnings:

```
[DISCUSSION_END:abandoned]

📋 讨论总结

**主题**: {original topic}
**状态**: 讨论未达成明确结论（参与者未响应）

群聊即将解散。
```

## Edge Cases

### Bot is Not Group Owner
If lark-cli returns an error indicating the bot is not the group owner:
1. Send a message: "⚠️ 无法自动解散群聊（Bot 不是群主）。请群主手动解散。"
2. Do NOT retry the dissolution command

### Critical Information in Discussion
If the discussion contains critical information that hasn't been captured:
1. Save the discussion summary before dissolving
2. Mention in the summary that important information was recorded

### User Wants to Continue After Warning
If after a timeout warning the user sends a meaningful response:
1. Cancel the dissolution
2. Continue the discussion normally
3. The timeout timer resets

## DO NOT

- ❌ Dissolve groups that are NOT discussion/temporary groups
- ❌ Dissolve groups without sending a summary first
- ❌ Retry dissolution on failure (most errors are non-retryable)
- ❌ End discussions that are still actively productive
- ❌ Dissolve permanent groups (e.g., main team channels)
- ❌ Use the `[DISCUSSION_END]` marker in normal conversation

## Integration Notes

- This skill works with `lark-cli` (Feishu official CLI) for group operations
- The dissolution command requires the bot to be the group owner
- Temporary chats created by the Chat Skill are automatically owned by the bot
- For non-bot-owned groups, inform the user to dissolve manually
