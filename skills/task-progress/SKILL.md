---
name: task-progress
description: Independent task progress reporter - monitors active deep-tasks and sends intelligent progress updates to users. Use for checking task status, progress reporting, or when user says keywords like "任务进度", "任务状态", "task progress", "progress report", "查看任务". Can be triggered manually or via schedule for periodic monitoring.
allowed-tools: [Read, Glob, Bash, send_user_feedback]
---

# Task Progress Reporter

Independent task progress reporter that monitors active deep-tasks and sends intelligent progress updates to users via Feishu.

## When to Use This Skill

**Use this skill for:**
- Checking status of active (in-progress) tasks
- Sending progress reports for running tasks
- Monitoring task execution health
- Triggered by scheduler for periodic monitoring

**Keywords that trigger this skill**: "任务进度", "任务状态", "task progress", "progress report", "查看任务", "进度更新"

**DO NOT use this skill for:**
- Creating tasks → Use `deep-task` skill
- Executing tasks → Use `executor` skill
- Evaluating tasks → Use `evaluator` skill

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based judgment to decide what progress information is worth reporting.**

This is NOT a fixed-interval reporter. Instead, you:
1. Read all active task files
2. Analyze the current state using your intelligence
3. Decide what the user would find valuable to know
4. Report only meaningful changes and important status updates

---

## Task File Architecture

Tasks are stored in `workspace/tasks/{taskId}/` with this structure:

```
tasks/{taskId}/
├── task.md                    # Task specification
├── final_result.md           # Present when task is COMPLETE (absent = still running)
├── running.lock              # Present when task is being processed
├── failed.md                 # Present when task has failed
└── iterations/
    ├── iter-1/
    │   ├── evaluation.md    # Evaluator's assessment (COMPLETE | NEED_EXECUTE)
    │   └── execution.md    # Executor's work summary
    ├── iter-2/
    │   ├── evaluation.md
    │   └── execution.md
    └── ...
```

**Task State Detection (by file existence):**
- `final_result.md` exists → Task is COMPLETE
- `failed.md` exists → Task has FAILED
- `running.lock` exists → Task is actively being processed
- Neither → Task is PENDING (waiting to be picked up)

---

## Analysis Process

### Step 1: Discover Active Tasks

Use `Glob` to find all task directories:

```
Glob: workspace/tasks/*/task.md
```

For each task directory found, check for `final_result.md`:
```
Glob: workspace/tasks/{taskId}/final_result.md
```

**Active tasks** = have `task.md` but NO `final_result.md`.

### Step 2: Read Task State

For each active task, read the following files:

1. **`task.md`** — Task description, requirements, expected results
   ```
   Read workspace/tasks/{taskId}/task.md
   ```

2. **Check for failure:**
   ```
   Glob: workspace/tasks/{taskId}/failed.md
   ```

3. **List iterations:**
   ```
   Glob: workspace/tasks/{taskId}/iterations/iter-*/evaluation.md
   ```

4. **Read latest evaluation.md** (highest iteration number):
   ```
   Read workspace/tasks/{taskId}/iterations/iter-{N}/evaluation.md
   ```

5. **Read latest execution.md** (if exists):
   ```
   Read workspace/tasks/{taskId}/iterations/iter-{N}/execution.md
   ```

### Step 3: Analyze and Decide What to Report

Use your LLM intelligence to evaluate each task and decide what's worth reporting:

**Always report:**
- Tasks that have failed (`failed.md` exists)
- Tasks stuck on a single iteration for a long time
- Tasks with many iterations (potential loop)
- First progress report for newly discovered tasks

**Skip reporting if:**
- No active tasks exist → Send "no active tasks" message
- No meaningful changes since last report → Skip silently
- Task just started (< 1 minute) → Too early for meaningful report

**Information to extract and summarize:**
- Task title and description (from task.md)
- Current iteration number
- Evaluation status (COMPLETE / NEED_EXECUTE)
- What the executor is currently working on
- Files modified (from execution.md)
- Any errors or blockers
- Time elapsed (based on iteration count and context)

### Step 4: Generate Progress Report

Create a structured progress report for all active tasks:

```markdown
## 🔄 任务进度报告

**活跃任务数**: {count}

---

### 📋 任务 1: {task_title}

| 属性 | 值 |
|------|-----|
| **任务 ID** | `{taskId}` |
| **当前迭代** | 第 {N} 轮 |
| **评估状态** | {NEED_EXECUTE / COMPLETE} |
| **任务状态** | {执行中 / 等待中 / 失败} |

**任务描述**: {brief description from task.md}

**当前进展**:
{summary of what executor is doing, from latest execution.md}

**评估反馈**:
{summary of evaluation guidance, from latest evaluation.md}

**已修改文件**:
{list of files from execution.md, if any}

---

### 📋 任务 2: {task_title}

...

---

💡 _下次检查时将自动更新进度_
```

### Step 5: Send Report

**CRITICAL**: Always send the report to the user using `send_user_feedback`.

```
Use send_user_feedback with:
- format: "text"
- content: [The progress report in markdown format]
- chatId: [The chatId from context]
```

**If no active tasks exist:**

```markdown
## ✅ 任务进度报告

当前没有活跃的任务。所有任务已完成或不存在。
```

---

## Report Templates

### Template 1: Single Active Task

```markdown
## 🔄 任务进度报告

### 📋 {task_title}

| 属性 | 值 |
|------|-----|
| **当前迭代** | 第 {N} 轮 |
| **评估状态** | NEED_EXECUTE |
| **任务状态** | 执行中 |

**当前进展**: {what executor is currently doing}

**评估反馈**: {evaluator's guidance for next steps}

---

_任务正在处理中，将持续监控_
```

### Template 2: Multiple Active Tasks

```markdown
## 🔄 任务进度报告

**活跃任务数**: {count}

---

### 📋 任务 1: {title}
- **迭代**: 第 {N} 轮 | **状态**: {status}
- **进展**: {summary}

### 📋 任务 2: {title}
- **迭代**: 第 {N} 轮 | **状态**: {status}
- **进展**: {summary}

---

_所有任务正在处理中_
```

### Template 3: Failed Task

```markdown
## ⚠️ 任务状态异常

### ❌ 任务: {task_title}

| 属性 | 值 |
|------|-----|
| **任务 ID** | `{taskId}` |
| **当前迭代** | 第 {N} 轮 |
| **状态** | 失败 |

**任务描述**: {description}

**失败原因**: {extract from failed.md if available, or "达到最大迭代次数"}

**最后执行摘要**: {from latest execution.md}

---

需要人工介入检查此任务。
```

### Template 4: No Active Tasks

```markdown
## ✅ 任务进度报告

当前没有活跃的任务。所有任务已完成或不存在。
```

---

## Intelligent Reporting Guidelines

### What Makes a Good Progress Report

1. **Concise**: Users don't need every detail, just the key points
2. **Actionable**: Highlight blockers or decisions needed
3. **Contextual**: Relative progress ("3rd iteration, fixing auth tests") not raw data
4. **Honest**: Report failures and stalls clearly

### Decision Framework

| Situation | Action |
|-----------|--------|
| 0 active tasks | Send "no active tasks" message |
| 1 active task, iteration 1, no execution yet | Send "task started, awaiting execution" |
| 1 active task, mid-iteration | Send progress with current focus |
| Multiple active tasks | Send consolidated report |
| Task has failed | Send alert with failure details |
| Task on iteration 5+ | Flag as potentially stuck |
| Task just completed (final_result.md just created) | Skip (reporter skill handles completion) |

### What to Ignore

- Tasks that have `final_result.md` (already complete, reporter skill handles these)
- Tasks in `iterations/final-summary.md` (already summarized)
- Empty or corrupted task directories

---

## Integration with Scheduled Execution

When triggered by a schedule, this skill:
1. Scans all active tasks
2. Generates a consolidated progress report
3. Sends to the configured chatId
4. Exits cleanly (no interactive prompts)

When triggered manually by a user, this skill:
1. Scans all active tasks
2. Generates a detailed progress report
3. Sends to the user's chatId
4. Can respond to follow-up questions

---

## Relationship to Other Skills

| Skill | Role | Relationship |
|-------|------|-------------|
| `deep-task` | Creates tasks | This skill monitors tasks created by deep-task |
| `evaluator` | Evaluates completion | This skill reads evaluation.md produced by evaluator |
| `executor` | Executes tasks | This skill reads execution.md produced by executor |
| `reporter` | Sends completion reports | Reporter handles final results; this skill handles mid-execution progress |

**Key difference from reporter**: The `reporter` skill sends final completion notifications. This skill sends **mid-execution** progress updates. They complement each other.

---

## Checklist

- [ ] Scanned `workspace/tasks/` for active tasks
- [ ] Read task.md for each active task
- [ ] Read latest evaluation.md and execution.md
- [ ] Checked for failed.md
- [ ] Used LLM judgment to decide what to report
- [ ] Generated structured progress report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any task files (read-only access)
- Create, delete, or move task files
- Send progress for completed tasks (final_result.md exists)
- Report on tasks older than 24 hours that haven't changed
- Create schedules without user confirmation
- Send reports to wrong chatId
- Make assumptions about task state without reading files
