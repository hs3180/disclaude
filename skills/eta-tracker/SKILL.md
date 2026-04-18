---
name: eta-tracker
description: Task ETA estimation and recording system. Records task estimates vs actual execution time in Markdown for continuous improvement. Use when user says "记录任务", "ETA", "预估时间", "任务记录", "eta-record", "eta-lookup", "task record", "time estimate", or wants to track task execution time and accuracy.
argument-hint: [record|lookup|review] [task-description-or-query]
allowed-tools: Read, Write, Edit, Glob, Grep
---

# ETA Tracker

Task execution time estimation and recording system. Track estimates vs actuals to improve future predictions.

## When to Use This Skill

**Use this skill for:**
- Recording a new task estimate before starting work
- Updating a task record with actual completion time
- Looking up similar past tasks for reference
- Reviewing estimation accuracy trends

**Keywords**: "记录任务", "ETA", "预估时间", "任务记录", "eta-record", "eta-lookup", "task record", "time estimate", "预估"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

---

## Commands

### 1. `record` — Record a Task

Record a new task or update an existing task with actual completion time.

**Usage**: `/eta-tracker record`

#### Step 1: Check for Existing Records

Read the task records file:

```
.claude/task-records.md
```

If the file does not exist, create it with the header:

```markdown
# 任务记录

> 任务执行记录，用于积累 ETA 预估经验。由 eta-tracker skill 维护。

---

```

#### Step 2: Collect Task Information

Ask the user (or infer from context) for the following:

| Field | Required | Description |
|-------|----------|-------------|
| Task name | Yes | Brief description of the task |
| Task type | Yes | One of: `bugfix`, `feature-small`, `feature-medium`, `feature-large`, `refactoring`, `research`, `documentation`, `test`, `chore`, `other` |
| Estimated time | Yes | Estimated duration (e.g., "30分钟", "2小时") |
| Estimation basis | Recommended | Why this estimate? Reference past similar tasks or reasoning |
| Actual time | If updating | Actual time spent |
| Review notes | If updating | What went well/poorly, lessons learned |

#### Step 3: Append Record

Append a new section to `.claude/task-records.md` using the **Edit** tool (insert at end of file):

**New task (estimate only):**

```markdown
## {YYYY-MM-DD} {task-name}

- **类型**: {task-type}
- **估计时间**: {estimated-time}
- **估计依据**: {estimation-basis}
- **状态**: 🔵 进行中
- **创建时间**: {YYYY-MM-DD HH:mm}
- **关联**: {related-issue-or-pr-if-any}

---
```

**Update with actual time (when task completes):**

```markdown
## {YYYY-MM-DD} {task-name}

- **类型**: {task-type}
- **估计时间**: {estimated-time}
- **实际时间**: {actual-time}
- **偏差**: {over/under/by-how-much}
- **估计依据**: {estimation-basis}
- **复盘**: {what-was-learned}
- **状态**: ✅ 已完成
- **创建时间**: {YYYY-MM-DD HH:mm}
- **完成时间**: {YYYY-MM-DD HH:mm}

---
```

#### Step 4: Confirm

Confirm to the user what was recorded. If updating with actual time, show the estimate vs actual comparison.

---

### 2. `lookup` — Find Similar Past Tasks

Search past records for tasks similar to a new task, to help inform estimation.

**Usage**: `/eta-tracker lookup [task-description]`

#### Step 1: Read Records

Read `.claude/task-records.md`.

If the file does not exist, inform the user:

> 暂无任务记录。使用 `/eta-tracker record` 开始记录第一个任务。

#### Step 2: Search for Similar Tasks

Search records for tasks matching the query by:
- Task type keywords (bugfix, feature, refactor, etc.)
- Technology/domain keywords (API, database, UI, auth, etc.)
- Task name similarity

#### Step 3: Present Results

Show matching records in a summary format:

```markdown
## 类似任务参考

找到 {N} 个相似任务：

| 任务 | 类型 | 估计 | 实际 | 偏差 |
|------|------|------|------|------|
| {task1-name} | {type} | {est} | {actual} | {delta} |
| {task2-name} | {type} | {est} | {actual} | {delta} |

### 建议估计
基于相似任务历史，建议预估：**{suggested-estimate}**
- 依据：{reasoning-based-on-past-tasks}
```

---

### 3. `review` — Review Estimation Accuracy

Analyze past task records to identify estimation patterns.

**Usage**: `/eta-tracker review`

#### Step 1: Read All Records

Read `.claude/task-records.md`.

If the file does not exist or has fewer than 3 completed tasks, inform the user:

> 任务记录不足，至少需要 3 条已完成记录才能生成分析。

#### Step 2: Analyze Patterns

Analyze completed tasks and calculate:

1. **Overall accuracy**: How often estimates match actuals?
2. **By task type**: Which types are most frequently over/under-estimated?
3. **Common patterns**: What factors lead to underestimation?
4. **Trend**: Is estimation accuracy improving over time?

#### Step 3: Generate Report

```markdown
## ETA 预估准确度分析

**分析范围**: {date-range}
**已完成任务数**: {count}

### 总体表现
- **平均偏差**: {avg-deviation}
- **高估次数**: {over-count} ({over-pct}%)
- **低估次数**: {under-count} ({under-pct}%)
- **准确估计**: {accurate-count} ({accurate-pct}%)

### 按类型分析

| 类型 | 数量 | 平均偏差 | 趋势 |
|------|------|----------|------|
| {type1} | {n} | {deviation} | {trend} |

### 低估常见原因
1. {reason-1}
2. {reason-2}

### 改进建议
1. {suggestion-1}
2. {suggestion-2}
```

---

## Record Format Reference

### File Location

`.claude/task-records.md` — stored in the project's `.claude/` directory as project knowledge.

### Entry Format

```markdown
## {date} {task-name}

- **类型**: {task-type}
- **估计时间**: {estimated-time}
- **实际时间**: {actual-time}
- **偏差**: {over/under/by-how-much}
- **估计依据**: {why-this-estimate}
- **复盘**: {lessons-learned}
- **状态**: {进行中 | 已完成 | 已放弃}
- **创建时间**: {datetime}
- **完成时间**: {datetime}
- **关联**: {issue/PR links}
```

### Task Types

| Type | Description | Typical Range |
|------|-------------|---------------|
| `bugfix` | Bug fix | 15-60 min |
| `feature-small` | Single feature point | 30-90 min |
| `feature-medium` | Multi-component feature | 2-4 hours |
| `feature-large` | Major feature | 4+ hours |
| `refactoring` | Code restructuring | Varies |
| `research` | Investigation/analysis | 1-3 hours |
| `documentation` | Docs/README | 30-60 min |
| `test` | Writing tests | 30-90 min |
| `chore` | Maintenance/tooling | 15-30 min |
| `other` | Uncategorized | Varies |

---

## Important Rules

1. **Always use Markdown format** — no structured data files (JSON/YAML). Free-form Markdown is the core design principle.
2. **Store in `.claude/task-records.md`** — this makes it part of the project knowledge that Claude can reference.
3. **Include estimation reasoning** — the value is in the "why", not just the numbers.
4. **Append, never delete** — keep history for learning. Only update status fields.
5. **Encourage review** — estimation improves through reflection.

---

## Checklist

After each operation, verify:
- [ ] Read `.claude/task-records.md` first (create if not exists)
- [ ] Used correct Markdown format
- [ ] Included all required fields
- [ ] Confirmed the record to the user

---

## DO NOT

- Use JSON/YAML for storage (Markdown only, per design principle)
- Delete past records
- Skip the estimation basis field
- Over-complicate the format (keep it free-form)
- Create structured schemas or databases
