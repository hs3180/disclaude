---
name: schedule
description: Schedule management specialist for RECURRING/SCHEDULED tasks. Use when user wants to create, view, modify, or delete scheduled/cron jobs, timers, reminders, or periodic executions. Triggered by keywords: "schedule", "timer", "cron", "定时任务", "提醒", "定期", "周期", "每天", "每周", "recurring", "periodic". For one-time tasks with full workflow, use /deep-task skill instead.
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
- One-time code changes → Use `/deep-task` skill instead
- Bug fixes or feature implementations → Use `/deep-task` skill instead
- Single execution operations → Use `/deep-task` skill instead

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

**IMPORTANT: Deletion is implemented as DISABLE, not file removal.**
- This preserves schedule history and allows re-enable if needed
- Files are NOT deleted; `enabled` is set to `false`

**Steps:**
1. Find schedule files with `Glob`: `workspace/schedules/*.md`
2. Read files with `Read`
3. Filter by current `chatId`
4. Confirm schedule to delete with user
5. Verify schedule belongs to current `chatId`
6. **DISABLE** with `Edit` tool: change `enabled: true` to `enabled: false`
7. **SEND FEEDBACK** confirming disable action

**Example:**
```markdown
# Before
enabled: true

# After (disable)
enabled: false
```

**Error Handling:**
- Schedule not found → send feedback with available schedules
- chatId mismatch → reject and explain
- Already disabled → inform user it's already disabled

**Why Disable Instead of Delete?**
- Preserves configuration for audit/history
- Allows quick re-enable if needed
- User can see past schedules

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

**Critical rules for writing effective schedule prompts that execute reliably.**

### 1. Self-Contained Context

❌ **Bad**: "Continue the task from yesterday"
✅ **Good**: "Check GitHub issues at https://github.com/user/repo/issues and summarize open bugs"

**Rule**: Each execution is independent. Include all necessary context, URLs, and instructions.

### 2. Specific and Actionable

❌ **Bad**: "Do some cleanup"
✅ **Good**: "Delete files in /tmp older than 7 days using: find /tmp -mtime +7 -delete"

**Rule**: Vague prompts lead to unpredictable results. Be explicit about actions.

### 3. Idempotent Operations

❌ **Bad**: "Add a log entry for today"
✅ **Good**: "Create or append to daily-log.md with today's date and status"

**Rule**: Same prompt running multiple times should not cause duplicate side effects.

### 4. Reasonable Time Window

❌ **Bad**: "Run a full system backup"
✅ **Good**: "Check backup status and send alert if last backup > 24 hours old"

**Rule**: Scheduled tasks should complete within reasonable time. For long tasks, check status instead of running full operation.

### 5. Clear Success/Failure Criteria

❌ **Bad**: "Check the API"
✅ **Good**: "Ping API endpoint /health, send alert if status != 200 or response time > 5s"

**Rule**: Define what success looks like so the agent knows when to report issues.

### 6. Avoid External Dependencies When Possible

❌ **Bad**: "Fetch data from the internal dashboard"
✅ **Good**: "Fetch data from https://api.example.com/metrics (auth: use env API_TOKEN)"

**Rule**: External services may be unavailable. Provide fallbacks or explicit error handling.

### 7. Include Error Handling Instructions

Example:
```markdown
Check daily sales report:
1. Fetch data from /api/reports/daily
2. If fetch fails, retry once after 30 seconds
3. If still fails, send alert: "Daily report unavailable"
4. On success, summarize top 3 products
```

**Rule**: Tell the agent what to do when things go wrong.

### Prompt Template

```markdown
## Objective
[One sentence describing the goal]

## Steps
1. [First action]
2. [Second action]
3. [Third action]

## Success Criteria
[What defines successful completion]

## On Failure
[What to do if steps fail]

## Output
[Expected format of result/feedback]
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
- **Physically delete schedule files** - Use disable (enabled: false) instead
- Complete operation without sending feedback
- Assume directory exists (check first)
- Execute unrelated operations
- Create vague or context-dependent prompts
