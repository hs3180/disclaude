---
name: eta-predictor
description: Task ETA estimation and execution time tracking. Use when user asks about task time estimates, when a task completes and timing should be recorded, or when user says keywords like "ETA", "预估时间", "任务记录", "task record", "estimate". Also auto-invoked after deep-task completion to record execution data.
allowed-tools: Read, Write, Edit, Glob, Grep
---

# Task ETA Predictor

Estimate task completion time using non-structured Markdown records. Track actual execution times, learn from patterns, and improve future estimates.

## When to Use This Skill

**Auto-invoke after task completion**:
- When a deep-task (Evaluator → Executor workflow) completes successfully
- Record task execution data to `.claude/task-records.md`

**Invoke when user asks**:
- "这个任务大概要多久" / "how long will this take"
- "预估一下时间" / "estimate the time"
- "任务记录" / "task records"
- "ETA" / "预计完成时间"

---

## Core Principle: Non-Structured Markdown

> **IMPORTANT**: All records are stored as free-form Markdown. No structured data formats (JSON, YAML, databases). The power comes from natural language records that the LLM can read and reason about.

- **Storage**: Markdown files in `.claude/` directory
- **Format**: Human-readable, with reasoning and context
- **Evolution**: Rules and records grow organically over time
- **Retrieval**: LLM reads and interprets records directly

---

## File Locations

| File | Purpose | Created |
|------|---------|---------|
| `.claude/task-records.md` | Historical task execution records | On first task completion |
| `.claude/eta-rules.md` | Estimation rules learned from experience | On first use |

Both files are in `.gitignore` (project-local, not committed).

---

## Workflow A: Record Task Completion

After a task completes, record its execution data.

### Step 1: Gather Task Information

Collect from the completed task:
- **Task description**: What was the task about?
- **Task type**: bugfix, feature, refactoring, test, docs, investigation
- **Scope**: small (single file), medium (few files), large (cross-module)
- **Estimated time**: Was there a prior estimate? If so, what was it?
- **Actual time**: Calculate from task creation to completion
- **Iterations**: How many Evaluator-Executor cycles were needed?
- **Outcome**: Completed successfully, partially completed, or failed

### Step 2: Calculate Actual Time

```
actual_time = completion_timestamp - task_creation_timestamp
```

Sources for timestamps:
- Task.md `Created` field → task creation time
- final_result.md creation time → completion time
- If precise timestamps unavailable, use approximate duration from log entries

### Step 3: Append Record to `.claude/task-records.md`

If the file doesn't exist, create it with the header. Then append:

```markdown
## {YYYY-MM-DD} {Task Title}

- **类型**: {bugfix | feature | refactoring | test | docs | investigation}
- **范围**: {small | medium | large}
- **估计时间**: {duration or "无"}
- **估计依据**: {why this estimate, or "首次执行"}
- **实际时间**: {duration}
- **迭代次数**: {N}
- **复盘**: {what went well, what was underestimated, lessons learned}
```

**Example entries**:

```markdown
# Task Records

## 2026-05-01 Fix WebSocket reconnection bug

- **类型**: bugfix
- **范围**: small
- **估计时间**: 20分钟
- **估计依据**: 类似之前的连接超时修复，单文件修改
- **实际时间**: 35分钟
- **复盘**: 低估了重连状态恢复的复杂度，需要额外处理消息队列的积压问题

## 2026-05-02 Add unit tests for task-tracker

- **类型**: test
- **范围**: medium
- **估计时间**: 1小时
- **估计依据**: 5个函数需要测试，每个约10分钟
- **实际时间**: 50分钟
- **复盘**: 估计准确，nock mock 模式已熟悉

## 2026-05-03 Refactor agent configuration system

- **类型**: refactoring
- **范围**: large
- **估计时间**: 2小时
- **估计依据**: 涉及3个模块的接口变更
- **实际时间**: 3.5小时
- **复盘**: 严重低估，级联依赖比预期多，类型错误修复耗时大量时间
```

### Step 4: Update ETA Rules (Optional)

If the record reveals a new pattern or corrects an existing rule, update `.claude/eta-rules.md`.

---

## Workflow B: Predict ETA for New Task

Before starting a task, predict how long it will take.

### Step 1: Read Historical Data

1. Read `.claude/task-records.md` for past similar tasks
2. Read `.claude/eta-rules.md` for estimation rules

### Step 2: Analyze the Task

Classify the new task:
- **Type**: bugfix, feature, refactoring, test, docs, investigation
- **Scope**: small / medium / large
- **Complexity factors**: async logic, type system, external API, unfamiliar code

### Step 3: Generate ETA Prediction

Based on rules + similar past tasks, output:

```markdown
## ETA 预测

**任务**: {task description}
**估计时间**: {duration}
**置信度**: {高 | 中 | 低}

**推理过程**:
1. 任务类型: {type}，基准时间 {range}
2. {complexity factor and its multiplier}
3. 参考相似任务: "{past task}" ({actual time})
4. 综合判断: {final estimate}

**参考**:
- task-records.md: "{past task entry date} {past task title}"
- eta-rules.md: "{applicable rule}"
```

### Step 4: Present to User

Share the prediction with the user, including the reasoning. The user can use this to plan their work.

---

## ETA Rules File Format

`.claude/eta-rules.md` template (created on first use):

```markdown
# ETA Estimation Rules

## Task Type Benchmarks

| 类型 | 基准时间 | 备注 |
|------|---------|------|
| bugfix | 15-30分钟 | 取决于复现难度 |
| feature-small | 30-60分钟 | 单一功能点 |
| feature-medium | 1-3小时 | 需要多个组件配合 |
| refactoring | 视范围而定 | 需要评估影响面 |
| test | 30-90分钟 | 取决于 mock 复杂度 |
| docs | 15-30分钟 | 主要是写作 |
| investigation | 30-60分钟 | 取决于线索清晰度 |

## Complexity Multipliers

| 因素 | 倍率 | 说明 |
|------|------|------|
| 涉及认证/安全 | ×1.5 | 安全逻辑需要额外审查 |
| 修改核心模块 | ×2.0 | 级联影响范围大 |
| 有现成参考代码 | ×0.7 | 可直接复用模式 |
| 涉及第三方 API | ×1.5 | 需要调试和对齐接口 |
| 异步/并发逻辑 | ×1.5 | 难以调试和测试 |
| TypeScript 类型重构 | ×1.3 | 类型错误修复耗时 |

## Known Patterns

_从历史任务中总结的模式会追加在这里_

## Bias Analysis

- **低估场景**: 异步逻辑、状态管理、级联依赖
- **高估场景**: 简单 CRUD、有参考代码的任务
```

---

## Recording Best Practices

### What Makes a Good Record

- **Be specific**: "修改了 chat-agent.ts 的消息队列处理" > "修了个 bug"
- **Include reasoning**: Why was the estimate off? What was unexpected?
- **Note surprises**: "本以为只需改1个文件，结果影响了3个模块"
- **Track iterations**: More iterations = more complexity than expected

### When NOT to Record

- Trivial tasks (< 5 minutes, like fixing a typo)
- Aborted tasks (no meaningful data)
- Purely informational queries (no code changes)

### Keeping Records Manageable

- Keep the most recent 50 entries
- Archive old entries by moving them to a summary section
- The LLM reads the whole file, so more context = better predictions

---

## Integration Points

### With Evaluator Skill

When a deep-task completes (Evaluator writes `final_result.md`), this skill should be triggered to record the execution data. The ChatAgent (main agent) can invoke this skill after receiving the task completion signal.

### With Deep-Task Skill

When creating a new task via `deep-task`, the ChatAgent can invoke this skill to provide an ETA prediction before task creation.

### Standalone Usage

Users can directly ask for:
- "记录刚才的任务" → Record the last completed task
- "预估这个任务的时间" → Predict ETA for a described task
- "查看任务记录" → Display task history summary
- "更新 ETA 规则" → Review and update estimation rules

---

## Checklist

For task recording:
- [ ] Gathered task information (type, scope, times)
- [ ] Calculated actual execution time
- [ ] Appended record to `.claude/task-records.md`
- [ ] Updated `.claude/eta-rules.md` if new pattern discovered

For ETA prediction:
- [ ] Read historical records and rules
- [ ] Classified the new task
- [ ] Generated prediction with reasoning
- [ ] Presented prediction to user
