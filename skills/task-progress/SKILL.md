---
name: task-progress
description: Independent task progress reporter - reads active task status from task files and sends intelligent progress updates to users. Use for progress reporting, task status checking, or when user says keywords like "任务进度", "进度报告", "task progress", "progress report", "任务状态". Can be triggered manually or via schedule for periodic progress checking.
allowed-tools: [Read, Glob, Bash, send_card]
---

# Task Progress Reporter

Independent task progress reporter that reads active task status from task files and sends intelligent progress updates to users.

## When to Use This Skill

**Use this skill for:**
- Checking progress of running deep tasks
- Sending progress updates to task owners
- Periodic task status monitoring (via schedule)
- Identifying stuck or long-running tasks

**Keywords that trigger this skill**: "任务进度", "进度报告", "task progress", "progress report", "任务状态", "查看进度"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

## Core Principle

**Use LLM-based analysis to intelligently report task progress.**

This skill acts as an **independent Reporter Agent** that:
1. Reads task files from the `tasks/` directory
2. Analyzes each active task's current state using prompts (not fixed rules)
3. Decides what progress information is worth reporting
4. Sends progress cards to the relevant users

---

## Progress Card Design

Use `send_card` to send progress updates. The card format:

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "🔄 任务进度报告"},
    "template": "blue"
  },
  "elements": [
    {"tag": "markdown", "content": "📊 **活跃任务**: N 个"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "### 任务 1\n**标题**: ...\n**状态**: 执行中\n**迭代**: 第 N 轮\n**已用时间**: X 分钟\n**当前进展**: ...\n**下一步**: ..."},
    {"tag": "hr"},
    {"tag": "markdown", "content": "### 任务 2\n..."},
    {"tag": "hr"},
    {"tag": "markdown", "content": "_更新时间: YYYY-MM-DD HH:mm_"}
  ]
}
```

### Status Icons

| Status | Icon | Template Color |
|--------|------|---------------|
| Running (has iterations) | 🔄 | blue |
| Created (no iterations yet) | ⏳ | turquoise |
| Completed (has final_result.md) | ✅ | green |
| Failed (has failed.md) | ❌ | red |
| Stuck (>30min no update) | ⚠️ | orange |

---

## Analysis Process

### Step 1: Discover Active Tasks

Use `Glob` to find all task directories:

```
Glob: workspace/tasks/*/task.md
```

For each task directory, check status files:
- `task.md` — Task specification (always exists)
- `final_result.md` — Task is complete
- `failed.md` — Task has failed
- `iterations/iter-N/evaluation.md` — Evaluation results
- `iterations/iter-N/execution.md` — Execution results
- `iterations/final-summary.md` — Final summary

### Step 2: Read Task Information

For each task, read these files to build a complete picture:

1. **task.md** — Extract:
   - Task title (first `#` heading)
   - Task ID (`**Task ID**` field)
   - Chat ID (`**Chat ID**` field)
   - Created timestamp (`**Created**` field)
   - Original request (`## Original Request` or `## Description` section)

2. **Latest evaluation.md** — Extract:
   - Status (`COMPLETE` or `NEED_EXECUTE`)
   - Assessment summary
   - Next actions (if NEED_EXECUTE)

3. **Latest execution.md** — Extract:
   - Summary of work done
   - Files modified
   - Expected results satisfied

4. **Calculate elapsed time** from `**Created**` timestamp to now.

### Step 3: Classify Task Status

Based on the files found, classify each task:

| Condition | Status |
|-----------|--------|
| `final_result.md` exists | ✅ Complete |
| `failed.md` exists | ❌ Failed |
| No `iterations/` directory | ⏳ Created (waiting) |
| Latest evaluation = `NEED_EXECUTE` | 🔄 Executing |
| Latest evaluation = `COMPLETE` but no `final_result.md` | 🔄 Finishing |
| No updates in >30 minutes | ⚠️ Possibly stuck |

### Step 4: Generate Progress Report

**IMPORTANT**: Use LLM intelligence to decide what to report. Do NOT use fixed rules.

For each active task, analyze the execution history and generate a **concise, informative** progress summary:

1. **What was the original request?** (from task.md)
2. **What progress has been made?** (from execution.md files)
3. **What is the current state?** (from latest evaluation.md)
4. **What needs to happen next?** (from evaluation Next Actions)
5. **Is the task on track?** (LLM judgment based on iterations vs progress)

**Reporting guidelines:**
- Be concise — users don't need every detail
- Highlight blockers or issues
- Show iteration count and elapsed time for context
- Group tasks by status (active, stuck, completed)
- Skip tasks that were just created (<1 minute old)

### Step 5: Send Progress Cards

**For each active task**, send a progress card to the task's Chat ID (extracted from task.md):

```
send_card({
  chatId: "<chat_id from task.md>",
  card: <progress card JSON>
})
```

**For the requesting chat**, send a summary card:

```
send_card({
  chatId: "<current chat_id from context>",
  card: <summary card JSON>
})
```

---

## Intelligent Reporting Rules

### When to Report

| Scenario | Action |
|----------|--------|
| Task has new iteration since last check | ✅ Report progress |
| Task is stuck (>30min no update) | ✅ Report with warning |
| Task just created (<1 min) | ❌ Skip (too early) |
| Task is complete | ✅ Report completion |
| Task has failed | ✅ Report failure |
| No active tasks | ✅ Report "no active tasks" |

### What to Include in Progress

For each task, include:
1. **Task title** (brief, from task.md heading)
2. **Current iteration** number
3. **Elapsed time** since creation
4. **Key progress** — what was accomplished (1-2 sentences)
5. **Next steps** — what the executor needs to do next
6. **Issues** — any blockers or concerns

### What to Exclude

- Raw file contents
- Full execution logs
- Technical implementation details
- Irrelevant system messages

---

## Schedule Integration

When triggered by a schedule, this skill:
1. Scans ALL active tasks across all chats
2. Sends individual progress cards to each task's respective chat
3. Only reports tasks with meaningful updates (avoids noise)

**Recommended schedule**: Every 5 minutes

---

## Edge Cases

### No Active Tasks

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "📋 任务进度报告"},
    "template": "turquoise"
  },
  "elements": [
    {"tag": "markdown", "content": "当前没有活跃的任务。"}
  ]
}
```

### Task Directory Exists But No task.md

Skip the task directory — it may be corrupted or incomplete.

### Chat ID Missing from task.md

Attempt to extract Chat ID from the task.md content. If not found, skip sending to that task's chat but include it in the summary.

### Malformed Files

If a file cannot be parsed, note it as "unable to read" and continue with other tasks.

---

## Manual Trigger

When a user explicitly asks for progress ("任务进度", "查看进度"), provide a detailed progress card for all tasks in the current chat.

When triggered by schedule, provide brief updates only for tasks with meaningful changes.

---

## Checklist

- [ ] Scan all task directories in `workspace/tasks/`
- [ ] Read task.md for each active task
- [ ] Read latest evaluation.md and execution.md
- [ ] Calculate elapsed time and iteration count
- [ ] Classify task status intelligently
- [ ] Generate progress cards using LLM analysis
- [ ] Send progress cards to relevant chats via `send_card`
- [ ] Handle edge cases (no tasks, malformed files, missing chat IDs)

---

## DO NOT

- Modify any task files (read-only access)
- Send progress for tasks that just started (<1 minute)
- Include raw file contents in progress cards
- Create or modify task directories
- Use fixed time intervals for reporting (use LLM judgment)
- Send noise (avoid reporting when nothing meaningful happened)
