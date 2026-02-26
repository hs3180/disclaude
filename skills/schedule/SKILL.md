---
name: schedule
description: Schedule task management specialist. Use when user wants to create, view, modify, or delete scheduled tasks. Triggered by keywords like "schedule", "timer", "cron", "定时任务", "提醒".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Schedule Task Manager

Manage scheduled tasks with full CRUD operations.

## Core Principle

**ALWAYS send feedback to user via `send_user_feedback` after EVERY operation.**

This is mandatory. Users must receive confirmation of operation results.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

**IMPORTANT**: Use `chatId` as task scope to ensure tasks only execute in the correct chat.

## Task File Location

Files stored in `workspace/schedules/` as Markdown files.

Filename format: `{name}-{uuid}.md`

---

## CRUD Operations

### 1. Create Task

**Steps:**
1. Collect task info:
   - Name (short description for filename)
   - Schedule (cron format or natural language)
   - Content (prompt to execute)

2. Generate unique filename: `{name}-{uuid}.md`

3. Create file with `Write` tool

4. **SEND FEEDBACK** confirming creation

**File Format:**
```markdown
---
name: Task Name
cron: "0 9 * * *"
enabled: true
chatId: oc_xxx
createdAt: 2024-01-01T00:00:00.000Z
---

Task content prompt here
```

---

### 2. Delete Task

**Steps:**
1. Find task files with `Glob`: `workspace/schedules/*.md`
2. Read files with `Read`
3. Filter by current `chatId`
4. Confirm task to delete
5. Verify task belongs to current `chatId`
6. Delete with `Bash rm`
7. **SEND FEEDBACK** confirming deletion

**Error Handling:**
- Task not found → send feedback with available tasks
- chatId mismatch → reject and explain

---

### 3. Update Task

**Modifiable Properties:**
- `cron`: Schedule
- `name`: Task name
- `enabled`: Enable/disable
- Content (body text)

**Steps:**
1. Find task file
2. Verify `chatId` ownership
3. Confirm changes
4. Modify with `Edit` tool
5. **SEND FEEDBACK** showing before/after

---

### 4. List Tasks

**Steps:**
1. Find all task files
2. Read each file
3. Filter by current `chatId`
4. Format and display
5. **SEND FEEDBACK** (even if no tasks found)

**Output Format:**
```
Scheduled Tasks:

| Name | Schedule | Status |
|------|----------|--------|
| Daily Report | Daily 9:00 | Enabled |
| Weekly Summary | Fri 14:00 | Disabled |
```

**No Tasks:**
```
No scheduled tasks found.
Would you like to create one?
```

---

## Cron Format

```
minute hour day month weekday
```

**Examples:**
- `"0 9 * * *"` - Daily at 9:00
- `"30 14 * * 5"` - Friday 14:30
- `"0 10 1 * *"` - 1st of month 10:00
- `"*/15 * * * *"` - Every 15 minutes
- `"0 * * * *"` - Hourly
- `"0 0 * * *"` - Daily at midnight

---

## Checklist

After each operation, verify:
- [ ] Used correct `chatId`?
- [ ] Verified task ownership?
- [ ] **Sent feedback to user?** (CRITICAL)

---

## DO NOT

- Create tasks without confirmation
- Modify/delete tasks from other chats
- Complete operation without sending feedback
- Assume directory exists (check first)
- Execute unrelated tasks
