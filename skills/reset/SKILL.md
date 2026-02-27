---
name: reset
description: Reset current conversation session. Use when user wants to clear context, cancel current task, or start fresh. Triggered by /reset command.
allowed-tools: []
---

# Skill: Reset Session

Reset the current conversation session and clear all context.

## When to Use This Skill

**Triggered by:** `/reset` command

**Use when user wants to:**
- Clear conversation context
- Cancel current task
- Start a fresh session
- Reset the agent state

## What This Skill Does

When invoked, this skill:

1. **Acknowledges the reset request** - Confirms to user that reset is in progress
2. **Clears session state** - The infrastructure handles the actual reset:
   - Closes the current agent session
   - Clears message queue
   - Removes thread tracking
   - Prepares for a fresh conversation

## Behavior

**IMPORTANT:** This is a system-level reset command. The actual session reset is handled by the infrastructure (CommunicationNode/PrimaryNode), not by this skill.

When you receive this command:
1. Send a brief confirmation message
2. Do NOT continue any previous task
3. Wait for user's next message to start fresh

## Response Template

```
✅ **对话已重置**

会话上下文已清除，可以开始新的对话。
```

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

## Important Notes

- This skill does NOT have access to file tools - reset is a lightweight operation
- The reset happens at the infrastructure level, ensuring complete session cleanup
- After reset, the next message starts a completely fresh conversation
- Previous context, including files and conversation history, is cleared

## Related Commands

- `/status` - Check current session status
- `/help` - Show available commands
