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

### 2. Delete Schedule (Disable)

**IMPORTANT**: Do NOT delete the schedule file. Instead, disable it by setting `enabled: false`.

This preserves the configuration for potential future reactivation and maintains an audit trail.

**Steps:**
1. Find schedule files with `Glob`: `workspace/schedules/*.md`
2. Read files with `Read`
3. Filter by current `chatId`
4. Confirm schedule to disable
5. Verify schedule belongs to current `chatId`
6. **Disable with `Edit` tool**: Change `enabled: true` to `enabled: false`
7. **SEND FEEDBACK** confirming the schedule is now disabled

**Example:**
```yaml
# Before
enabled: true

# After
enabled: false
```

**Error Handling:**
- Schedule not found → send feedback with available schedules
- chatId mismatch → reject and explain
- Already disabled → inform user it's already disabled

**Why disable instead of delete?**
- Preserves configuration for future reactivation
- Maintains audit trail of past schedules
- Allows reviewing disabled schedules
- User can permanently delete manually if needed

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

## Schedule Prompt Guidelines

**CRITICAL**: Well-written prompts ensure efficient execution. Follow these guidelines:

### 1. Be Self-Contained

❌ **Bad**: "Continue the task from yesterday"
✅ **Good**: "Check the disclaude repository for new issues and create a PR if applicable"

The prompt must contain ALL necessary context. The scheduler executes in a fresh session with no memory of previous conversations.

### 2. Avoid Creating New Schedules

❌ **Bad**: "Create a daily reminder to check emails"
✅ **Good**: "Check emails and report new important messages"

Scheduled tasks cannot create other scheduled tasks (anti-recursion protection). If periodic behavior is needed, report to user instead.

### 3. Specify Clear Success Criteria

❌ **Bad**: "Do something with the database"
✅ **Good**: "Run database backup and verify the backup file exists in /backups/"

Define what "done" looks like. Include verification steps when possible.

### 4. Include Error Handling Instructions

❌ **Bad**: "Send a report"
✅ **Good**: "Send a report. If the API is unavailable, retry once after 5 minutes, then report failure."

Specify what to do when things go wrong.

### 5. Limit Scope and Dependencies

❌ **Bad**: "Fix all bugs in the system"
✅ **Good**: "Check issue #123 and report its current status"

Avoid broad or unbounded tasks. Each execution should have clear boundaries.

### 6. Provide Resource References

❌ **Bad**: "Check the config file"
✅ **Good**: "Check the config file at `/app/workspace/config.yaml`"

Include full paths, URLs, or identifiers. Don't assume the executor knows where things are.

### 7. Consider Execution Time

❌ **Bad**: "Analyze the entire codebase and refactor"
✅ **Good**: "Run the test suite for the schedule module"

Scheduled tasks should complete within reasonable time. Break large tasks into smaller scheduled checks.

### Prompt Template

```markdown
## Objective
[What should be accomplished]

## Context
[Any necessary background information]

## Steps
1. [First step]
2. [Second step]
...

## Success Criteria
[How to verify the task completed successfully]

## Error Handling
[What to do if something fails]
```

---

## Checklist

After each operation, verify:
- [ ] Used correct `chatId`?
- [ ] Verified schedule ownership?
- [ ] **Sent feedback to user?** (CRITICAL)

---

## DO NOT

- Create schedules without confirmation
- Modify schedules from other chats
- Delete schedule files (disable instead with `enabled: false`)
- Complete operation without sending feedback
- Assume directory exists (check first)
- Execute unrelated operations
- Create new schedules from within a scheduled task execution
- Write prompts that depend on previous conversation context
