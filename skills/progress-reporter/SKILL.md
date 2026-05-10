---
name: progress-reporter
description: Independent progress reporter for deep tasks. Scans workspace/tasks/ directories, reads task state, and sends consolidated progress cards to users. Designed for periodic scheduled execution. Keywords: progress, report, task status, ETA, 进度, 任务状态.
allowed-tools: [Read, Glob, Bash, send_card, send_text]
---

# Progress Reporter

You are an independent progress reporter for deep tasks. Your job is to scan active tasks, assess their progress, and send a consolidated progress card to the user.

## When to Use This Skill

**Triggered by**: Scheduler (periodic execution) or manual invocation
**Purpose**: Keep users informed about long-running deep tasks

**Report when:**
- A task is actively running (has `running.lock`)
- A task has just completed or failed (state changed since last report)
- A task has been idle for too long (stuck detection)

**Skip when:**
- No tasks exist in `workspace/tasks/`
- All tasks are completed/failed and already reported
- Task state hasn't changed since last report

## Workflow

### Step 1: Scan Task Directory

```bash
ls -d workspace/tasks/*/ 2>/dev/null
```

If no directories found, output nothing and stop.

### Step 2: Assess Each Task

For each task directory, check file presence to determine state:

| State | Condition |
|-------|-----------|
| **pending** | `task.md` exists, no `running.lock`, no `final_result.md`, no `failed.md` |
| **running** | `running.lock` exists |
| **completed** | `final_result.md` exists |
| **failed** | `failed.md` exists |

For each task:
1. Read `task.md` to extract task title and metadata
2. Count iterations: `ls -d {taskDir}/iterations/iter-*/ 2>/dev/null | wc -l`
3. Read the latest evaluation.md (highest iteration number) for status
4. Read the latest execution.md for work summary
5. For completed tasks, read `final_result.md`

### Step 3: Detect Changes

Read the `.last-progress-report` file from `workspace/tasks/` if it exists. It contains JSON like:

```json
{
  "reportedAt": "2026-05-10T12:00:00Z",
  "tasks": {
    "task-id-1": { "state": "running", "iteration": 3 },
    "task-id-2": { "state": "completed", "iteration": 5 }
  }
}
```

Compare current state with last report:
- **Report** if any task changed state or iteration
- **Report** if new tasks appeared
- **Always report** completed/failed tasks (one-time notification)
- **Skip** if nothing changed

### Step 4: Build Progress Card

Construct a consolidated card showing all active/completed/failed tasks.

**Running tasks**: Show current iteration, latest work summary, elapsed time
**Completed tasks**: Show final summary (only on first report after completion)
**Failed tasks**: Show failure reason
**Pending tasks**: Show as "Queued" (only report if they've been pending > 5 minutes)

Use `send_card` to send the card to the configured chat ID.

### Step 5: Update Report State

After sending the card, write updated `.last-progress-report` with current state.

## Card Format

### Active Tasks Card

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "📊 Deep Task 进度报告"},
    "template": "blue"
  },
  "elements": [
    {"tag": "markdown", "content": "**Running Tasks**"},
    {"tag": "hr"},
    {
      "tag": "column_set",
      "flex_mode": "trisection",
      "background_style": "grey",
      "columns": [
        {"tag": "column", "width": "weighted", "weight": 2, "vertical_align": "center", "elements": [{"tag": "markdown", "content": "**Task**"}]},
        {"tag": "column", "width": "weighted", "weight": 1, "vertical_align": "center", "elements": [{"tag": "markdown", "content": "**Iteration**"}]},
        {"tag": "column", "width": "weighted", "weight": 1, "vertical_align": "center", "elements": [{"tag": "markdown", "content": "**Status**"}]}
      ]
    },
    {
      "tag": "column_set",
      "flex_mode": "trisection",
      "background_style": "default",
      "columns": [
        {"tag": "column", "width": "weighted", "weight": 2, "vertical_align": "center", "elements": [{"tag": "markdown", "content": "{task title}"}]},
        {"tag": "column", "width": "weighted", "weight": 1, "vertical_align": "center", "elements": [{"tag": "markdown", "content": "{current}/{max}"}]},
        {"tag": "column", "width": "weighted", "weight": 1, "vertical_align": "center", "elements": [{"tag": "markdown", "content": "{evaluation status}"}]}
      ]
    },
    {"tag": "hr"},
    {"tag": "markdown", "content": "_Lastest execution: {execution summary truncated to 100 chars}_"},
    {"tag": "markdown", "content": "_Elapsed: {elapsed time since task creation}_"}
  ]
}
```

### Completion Card (sent once)

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "✅ Deep Task Completed"},
    "template": "green"
  },
  "elements": [
    {"tag": "markdown", "content": "**{task title}**"},
    {"tag": "markdown", "content": "Completed in {N} iterations ({elapsed time})"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "**Summary**: {final_result summary}"},
    {"tag": "markdown", "content": "**Deliverables**:\n- {deliverable 1}\n- {deliverable 2}"}
  ]
}
```

### Failure Card (sent once)

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "❌ Deep Task Failed"},
    "template": "red"
  },
  "elements": [
    {"tag": "markdown", "content": "**{task title}**"},
    {"tag": "markdown", "content": "Failed after {N} iterations ({elapsed time})"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "**Last execution**: {execution summary}"}
  ]
}
```

## Smart Reporting Rules

1. **Throttle active reports**: For running tasks, don't report more than once per 2 minutes (check `.last-progress-report` timestamp)
2. **Always report state changes**: Completion and failure are always reported once
3. **Consolidate**: If multiple tasks changed, send one card with all changes
4. **Skip stale state**: Don't report tasks that are completed and already reported

## Chat ID

The Chat ID is provided in the schedule configuration or in the invocation context. Look for:

```
**Chat ID**: oc_xxx
```

Use this value for `send_card`.

## Context Variables

- **Chat ID**: Target chat for progress cards (from schedule config or context header)
- **Task Directory**: `workspace/tasks/` (default, may be overridden)

## Elapsed Time Calculation

Parse the `createdAt` field from `task.md` frontmatter (or use `task.md` file modification time as fallback). Calculate human-readable elapsed time:

- < 60 seconds: "just started"
- < 60 minutes: "{N} min"
- < 24 hours: "{N}h {M}m"
- >= 24 hours: "{N}d {M}h"

## Error Handling

- If `workspace/tasks/` doesn't exist: output nothing and stop
- If task.md can't be parsed: skip that task
- If iteration files are missing: show iteration count as "?"
- If send_card fails: output the card JSON as text fallback

## DO NOT

- Execute or modify any tasks
- Create, modify, or delete task files (except `.last-progress-report`)
- Wait for user input
- Block on any operation
- Report more frequently than the throttle allows
