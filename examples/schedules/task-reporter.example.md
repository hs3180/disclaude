---
name: "Task Progress Reporter"
cron: "0 */5 * * * *"
enabled: false
blocking: false
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# Task Progress Reporter

Periodically scans running deep tasks and sends intelligent progress reports to users.

## Background

This schedule implements the **independent Reporter Agent** pattern from Issue #857.
Instead of using fixed-interval progress reporting, this agent intelligently decides
when and what to report based on task context.

The architecture is:

```
┌─────────────────┐     ┌──────────────────┐
│   Deep Task     │────▶│  progress.md     │
│   (Executor)    │     │  (Task Context)  │
└─────────────────┘     └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │ Task Reporter    │
                        │ (this schedule)  │
                        └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  User (chatId)   │
                        └──────────────────┘
```

## Configuration

- **Scan interval**: Every 5 minutes
- **Task directory**: `workspace/tasks/`
- **Notification target**: Configured chatId
- **Min report interval**: 5 minutes per task (deduplication)

## Execution Steps

### 1. Scan for running tasks

```bash
# Find tasks that are currently running (have running.lock)
for dir in workspace/tasks/*/; do
  if [ -f "$dir/running.lock" ]; then
    echo "$dir"
  fi
done
```

### 2. Check deduplication

For each running task, check if a recent report was already sent:

```bash
# Check .last-report timestamp
cat workspace/tasks/{taskId}/.last-report 2>/dev/null || echo "never"
```

**Skip reporting if**:
- `.last-report` exists and is less than 5 minutes old
- AND task status has not changed since last report

### 3. Read task context

For each task that passes deduplication check:

1. **Read `progress.md`** (primary source):
   - Current step, completed steps, status, notes
   - This is written by the Executor during task execution

2. **Fallback: Infer from files** (if progress.md doesn't exist):
   - Read `task.md` for task title and requirements
   - Count `iterations/iter-*` directories
   - Read latest `iterations/iter-N/execution.md`

3. **Read `task.md`** for:
   - Task title (for report header)
   - Chat ID (for sending report)

### 4. Decide whether to report

Apply the task-reporter skill's reporting criteria:

| Condition | Report? |
|-----------|---------|
| New iteration completed since last report | ✅ Yes |
| Status changed (error detected) | ✅ Yes |
| More than 5 min since last report AND progress changed | ✅ Yes |
| Less than 5 min since last report AND no status change | ❌ No |
| No progress since last report | ❌ No |

### 5. Generate and send report

Use `send_interactive` to send a progress card:

```
send_interactive({
  content: {
    config: { wide_screen_mode: true },
    header: {
      title: { content: "🔄 Task Progress: {task title}", tag: "plain_text" },
      template: "blue"
    },
    elements: [
      { tag: "markdown", content: "**Status**: 🔄 Running | **Iteration**: {n}/{max} | **Elapsed**: {time}" },
      { tag: "hr" },
      { tag: "markdown", content: "**Current**: {current step}\n**Progress**: {completed}/{total} steps" }
    ]
  },
  format: "card",
  chatId: "{chatId from task.md or config}",
  actionPrompts: {}
})
```

### 6. Update last report time

After sending a report, write the current timestamp:

```bash
date -u +"%Y-%m-%dT%H:%M:%SZ" > workspace/tasks/{taskId}/.last-report
```

## Task Directory Structure (Extended)

```
tasks/{taskId}/
├── task.md           → Task specification
├── progress.md       → Task Context (written by Executor)
├── final_result.md   → Task completed ✅
├── running.lock      → Task running 🔄
├── failed.md         → Task failed ❌
├── .last-report      → Last progress report timestamp
└── iterations/
    ├── iter-1/
    │   ├── evaluation.md
    │   └── execution.md
    └── iter-N/
```

## Error Handling

- If no running tasks found → skip silently (no report needed)
- If `progress.md` read fails → fall back to inferring from iteration files
- If `send_interactive` fails → log error, retry on next scan
- If task directory is corrupted → skip and log warning

## Integration with Deep Task Scanner

This schedule works alongside the `deep-task` scanner:

| Scanner | Role | Interval |
|---------|------|----------|
| `deep-task` | Execute tasks (Evaluator → Executor cycle) | 30 seconds |
| `task-reporter` | Report progress to users | 5 minutes |

The two scanners are independent and communicate only through shared files:
- `deep-task` (via Executor) writes `progress.md`
- `task-reporter` reads `progress.md` and sends reports

## Usage

1. Copy this file to `workspace/schedules/task-reporter.md`
2. Replace `chatId` with actual Feishu chat ID
3. Set `enabled: true`
4. Ensure `deep-task` scanner is also running
5. The reporter will automatically detect running tasks and send progress updates
