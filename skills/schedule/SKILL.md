---
name: schedule
description: Schedule management specialist. Use when user wants to create, view, modify, or delete schedules. Triggered by keywords like "schedule", "timer", "cron", "定时任务", "提醒".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Schedule Manager

Manage schedules with full CRUD operations.

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

### 2. Disable Schedule (Recommended)

**IMPORTANT**: Prefer disabling schedules over deleting them. Disabled schedules can be re-enabled later.

**Steps:**
1. Find schedule files with `Glob`: `workspace/schedules/*.md`
2. Read files with `Read`
3. Filter by current `chatId`
4. Confirm schedule to disable
5. Verify schedule belongs to current `chatId`
6. Set `enabled: false` with `Edit` tool
7. **SEND FEEDBACK** confirming schedule is disabled

**Example:**
```yaml
# Before
enabled: true

# After
enabled: false
```

---

### 3. Delete Schedule (Only if absolutely necessary)

**WARNING**: Only delete schedules when they are truly no longer needed. Prefer disabling.

**Steps:**
1. First, try to disable the schedule (see above)
2. If user insists on deletion, confirm once more
3. Verify schedule belongs to current `chatId`
4. Delete with `Bash rm`
5. **SEND FEEDBACK** confirming deletion

**Error Handling:**
- Schedule not found → send feedback with available schedules
- chatId mismatch → reject and explain

---

### 4. Update Schedule

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

### 5. List Schedules

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

---

## Schedule Prompt Best Practices

When creating or modifying schedule prompts, follow these guidelines to ensure efficient execution:

### 1. Be Specific and Self-Contained

**Good:**
```markdown
Summarize the issues created in hs3180/disclaude repository today.
List each issue with its title, number, and brief description.
```

**Bad:**
```markdown
Check the issues. (Too vague - what repo? what to check?)
```

### 2. Include All Necessary Context

The prompt executes in an isolated context. Include:
- Repository names (owner/repo format)
- Specific file paths
- Required parameters

**Good:**
```markdown
Review open issues in hs3180/disclaude and list:
1. Bug reports (high priority)
2. Feature requests (medium priority)
3. Documentation issues (low priority)
```

### 3. Define Clear Success Criteria

What should the output look like?

**Good:**
```markdown
Generate a daily standup report with:
- ✅ Completed tasks
- 🔄 In progress tasks
- ⏳ Blocked tasks
Format as a markdown checklist.
```

### 4. Keep Prompts Focused

One schedule = one task. Don't combine unrelated operations.

**Good:** Create separate schedules for:
- Daily issue summary
- Weekly PR review
- Monthly metrics report

**Bad:** One schedule doing all three

### 5. Handle Errors Gracefully

Include fallback instructions:

**Good:**
```markdown
Fetch recent commits from hs3180/disclaude.
If API fails, report the error and suggest retry.
```

### 6. Consider Execution Time

- Short tasks (< 1 min): Any frequency
- Medium tasks (1-5 min): Hourly or less frequent
- Long tasks (> 5 min): Daily or less frequent

Use `blocking: true` for long-running tasks to prevent overlap.

### 7. Example Prompt Template

```markdown
# Task: [Clear task name]

## Objective
[One sentence describing the goal]

## Steps
1. [First step]
2. [Second step]
3. [Third step]

## Expected Output
[Description of what success looks like]

## Error Handling
[What to do if something goes wrong]
```

