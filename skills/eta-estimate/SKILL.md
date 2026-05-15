---
name: eta-estimate
description: Estimate task completion time based on historical records. Use when starting a new task, user asks "how long will this take", "ETA", "时间预估", "estimate time", or when recording completed task info. Also triggered after task completion to record execution details.
allowed-tools: Read, Write, Edit, Glob, Grep
---

# Task ETA Estimation

Estimate task completion time by referencing historical task records and ETA rules.

## When to Use This Skill

**Use this skill for:**
- Estimating how long a new task will take before starting
- Recording completed task info (estimated vs actual time)
- Reviewing historical task records for patterns
- Keywords: "ETA", "时间预估", "estimate time", "任务预估", "how long"

## Core Principle

**Non-structured Markdown storage.** Task records and estimation rules are stored as free-form Markdown files, not structured databases. The LLM reads and interprets these directly.

## File Locations

- **Task Records**: `.claude/task-records.md` — Historical task execution records
- **ETA Rules**: `.claude/eta-rules.md` — Learned estimation rules and baselines

## Workflow

### Step 1: Check Existing Records

Read the task records and rules files:

```
.claude/task-records.md
.claude/eta-rules.md
```

If they don't exist, use the default baselines below.

### Step 2: Estimate (Before Starting a Task)

Analyze the task and provide an ETA estimate:

1. **Identify task type**: bugfix, feature, refactoring, research, test, docs, chore
2. **Find similar historical tasks** in `.claude/task-records.md`
3. **Apply rules** from `.claude/eta-rules.md`
4. **Generate estimate** with reasoning

Output format:

```markdown
## ETA 预测

**估计时间**: {duration}
**置信度**: {high/medium/low}

**推理过程**:
1. 任务类型: {type}，基准时间 {baseline}
2. {adjustment factor 1}
3. {adjustment factor 2}
4. 参考相似任务: "{similar task title}" ({actual time})
5. 综合判断: {final estimate}
```

### Step 3: Record (After Completing a Task)

Append a record to `.claude/task-records.md` in this format:

```markdown
## YYYY-MM-DD {Task Title}

- **类型**: {taskType}
- **估计时间**: {estimatedTime}
- **估计依据**: {why this estimate was chosen}
- **实际时间**: {actualTime}
- **复盘**: {what went well, what was underestimated, lessons learned}
```

**Example**:

```markdown
## 2026-05-16 Fix WebSocket reconnection bug

- **类型**: bugfix
- **估计时间**: 30分钟
- **估计依据**: Similar to previous connection timeout fix, mostly error handling
- **实际时间**: 45分钟
- **复盘**: Underestimated edge case where multiple reconnects fire simultaneously. Need debouncing logic next time.
```

### Step 4: Update Rules (Periodic)

After recording 5+ new entries, review patterns and update `.claude/eta-rules.md`:

- Add new experience rules
- Adjust baseline times
- Update bias analysis

## Default Baselines (When No Records Exist)

| 类型 | 基准时间 |
|------|---------|
| bugfix | 15-30分钟 |
| feature (small) | 30-60分钟 |
| feature (medium) | 2-4小时 |
| refactoring | 视范围而定 |
| test | 20-45分钟 |
| docs | 15-30分钟 |
| research | 1-2小时 |
| chore | 10-20分钟 |

## Recording Guidelines

- **Be honest**: Even rough estimates help build accuracy over time
- **Include estimation basis**: Reference similar past tasks or specific complexity factors
- **Keep reviews concise**: One or two sentences about what was learned
- **Read existing records before estimating**: Check past similar tasks to improve accuracy
- **Do NOT skip recording**: Consistent records are essential for improving future estimates

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

## DO NOT

- Create structured databases or JSON files for records
- Skip the estimation basis field — it's the most valuable for learning
- Over-engineer the estimation process — keep it simple and fast
- Record tasks that took less than 5 minutes (too noisy for pattern matching)
