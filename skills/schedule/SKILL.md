---
name: schedule
description: Schedule management specialist for RECURRING/SCHEDULED tasks. Use when user wants to create, view, modify, or delete scheduled/cron jobs, timers, reminders, or periodic executions. Triggered by keywords: "schedule", "timer", "cron", "定时任务", "提醒", "定期", "周期", "每天", "每周", "recurring", "periodic". For one-time tasks, use /task skill instead.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Schedule Manager

Manage schedules with full CRUD operations.

## When to Use This Skill

**✅ Use this skill for:**
- Creating scheduled/recurring tasks
- Setting up cron jobs
- Managing timers and reminders
- Periodic executions (daily, weekly, monthly, etc.)
- Viewing or modifying existing schedules

**❌ DO NOT use this skill for:**
- One-time code changes → Use `/task` skill instead
- Bug fixes or feature implementations → Use `/task` skill instead
- Single execution operations → Use `/task` skill instead

**Keywords that trigger this skill**: "定时任务", "schedule", "cron", "timer", "reminder", "每天", "每周", "定期", "周期性", "recurring", "periodic"

## Core Principle

**ALWAYS send feedback to user via `send_user_feedback` after EVERY operation.**

This is mandatory. Users must receive confirmation of operation results.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

**IMPORTANT**: Use `chatId` as schedule scope to ensure schedules only execute in the correct chat.

## Schedule File Location

Files stored in `workspace/schedules/` as Markdown files.

Filename format: `{name}-{uuid}.md`

---

## CRUD Operations

### 1. Create Schedule

**Steps:**
1. Collect schedule info:
   - Name (short description for filename)
   - Cron expression (cron format or natural language)
   - Content (prompt to execute)

2. Generate unique filename: `{name}-{uuid}.md`

3. Create file with `Write` tool

4. **SEND FEEDBACK** confirming creation

**File Format:**
```markdown
---
name: Schedule Name
cron: "0 9 * * *"
enabled: true
blocking: true
chatId: oc_xxx
createdAt: 2024-01-01T00:00:00.000Z
---

Schedule content prompt here
```

**Field Reference:**
| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | - | Schedule display name |
| `cron` | Yes | - | Cron expression for timing |
| `enabled` | No | `true` | Whether schedule is active |
| `blocking` | No | `true` | Skip execution if previous run still in progress |
| `chatId` | Yes | - | Chat ID for execution context |
| `createdAt` | No | - | Creation timestamp |

---

### 2. Delete Schedule

**Steps:**
1. Find schedule files with `Glob`: `workspace/schedules/*.md`
2. Read files with `Read`
3. Filter by current `chatId`
4. Confirm schedule to delete
5. Verify schedule belongs to current `chatId`
6. Delete with `Bash rm`
7. **SEND FEEDBACK** confirming deletion

**Error Handling:**
- Schedule not found → send feedback with available schedules
- chatId mismatch → reject and explain

---

### 3. Update Schedule

**Modifiable Properties:**
- `cron`: Execution time
- `name`: Schedule name
- `enabled`: Enable/disable
- `blocking`: Blocking mode
- Content (body text)

**Steps:**
1. Find schedule file
2. Verify `chatId` ownership
3. Confirm changes
4. Modify with `Edit` tool
5. **SEND FEEDBACK** showing before/after

---

### 4. List Schedules

**Steps:**
1. Find all schedule files
2. Read each file
3. Filter by current `chatId`
4. Format and display
5. **SEND FEEDBACK** (even if no schedules found)

**Output Format:**
```
Schedules:

| Name | Cron | Status |
|------|------|--------|
| Daily Report | Daily 9:00 | Enabled |
| Weekly Summary | Fri 14:00 | Disabled |
```

**No Schedules:**
```
No schedules found.
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
- [ ] Verified schedule ownership?
- [ ] **Sent feedback to user?** (CRITICAL)

---

## DO NOT

- Create schedules without confirmation
- Modify/delete schedules from other chats
- Complete operation without sending feedback
- Assume directory exists (check first)
- Execute unrelated operations
