---
name: task-eta
description: Task ETA estimation and execution time recording. Records task execution history in Markdown for time estimation. Use when user asks "how long will this take", "estimate time", "task ETA", "时间预估", "任务耗时", "ETA", or when a task completes and time should be recorded.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# Task ETA Estimation Skill

You manage task execution time records and provide ETA estimates based on historical data. All data is stored as **unstructured Markdown** — no structured interfaces.

## Core Principle

> **Use non-structured Markdown free storage, not structured data.**

- Task records are stored as Markdown
- Estimation rules evolve naturally through experience
- Records include full reasoning chains for retrospective analysis

## File Locations

| File | Purpose | Created When |
|------|---------|-------------|
| `.claude/task-records.md` | Task execution history | First task recording |
| `.claude/eta-rules.md` | ETA estimation rules | First ETA request |

## Workflow 1: Record Completed Task

When a task completes (user confirms or `final_result.md` is created), record the execution time.

### Steps

1. **Determine task type** and key characteristics
2. **Calculate actual duration** from start/end timestamps (if available) or ask user
3. **Append record** to `.claude/task-records.md`

### Record Format

Append to `.claude/task-records.md`:

```markdown
## {YYYY-MM-DD HH:MM} {Task Title}

- **类型**: {bugfix | feature-small | feature-medium | feature-large | refactoring | test | docs | research}
- **范围**: {single-file | multi-file | cross-module | full-system}
- **估计时间**: {之前给出的估计，首次为 "无估计"}
- **估计依据**: {参考了哪些历史记录和规则}
- **实际时间**: {实际耗时，如 "45分钟"}
- **偏差分析**: {高估/低估原因分析}
- **关键因素**: {影响耗时的关键因素，如 "涉及异步逻辑"、"有现成参考代码"}

---
```

### Important

- If `.claude/task-records.md` doesn't exist, create it with a header:

```markdown
# 任务执行记录

> 自动记录任务执行时间，用于 ETA 预估。由 task-eta skill 维护。

---
```

- Keep records concise — focus on information useful for future estimation
- Use consistent terminology for task types

## Workflow 2: Estimate ETA for New Task

When asked to estimate how long a task will take.

### Steps

1. **Read** `.claude/eta-rules.md` (if exists) for estimation rules
2. **Read** `.claude/task-records.md` (if exists) for similar past tasks
3. **Analyze** task type, scope, and key characteristics
4. **Produce** ETA estimate with reasoning chain

### Estimation Output Format

```markdown
## ETA 预估

**任务**: {task description}
**估计时间**: {X分钟/X小时}
**置信度**: {高 | 中 | 低}

**推理过程**:
1. 任务类型: {type}，基准时间 {range}
2. {Rule or historical reference 1}
3. {Rule or historical reference 2}
4. 综合判断: {final reasoning}

**参考**:
- {Reference to specific rule or past task record}
```

## Workflow 3: Update ETA Rules

After significant task recordings (every 5-10 tasks), update the estimation rules.

### Steps

1. **Analyze** recent task records for patterns
2. **Identify** systematic biases (consistently over/under estimating certain task types)
3. **Update** `.claude/eta-rules.md`

### Rules File Format

If `.claude/eta-rules.md` doesn't exist, create it:

```markdown
# ETA 估计规则

> 基于 task-records.md 中的历史数据持续优化。由 task-eta skill 维护。

## 任务类型基准时间

| 类型 | 基准时间 | 备注 |
|------|---------|------|
| bugfix | 15-30分钟 | 取决于复现难度 |
| feature-small | 30-60分钟 | 单一功能点 |
| feature-medium | 1-3小时 | 需要多个组件配合 |
| feature-large | 3-8小时 | 跨模块功能 |
| refactoring | 视范围而定 | 需要评估影响面 |
| test | 15-45分钟 | 取决于测试复杂度 |
| docs | 10-30分钟 | 文档更新 |
| research | 30-90分钟 | 技术调研和分析 |

## 经验调整规则

1. **涉及认证/安全** → 基准时间 × 1.5
2. **需要修改核心模块** → 基准时间 × 2
3. **有现成参考代码** → 基准时间 × 0.7
4. **涉及第三方 API 集成** → 基准时间 × 1.5
5. **首次处理某类问题** → 基准时间 × 1.3

## 偏差分析

_（基于 task-records.md 持续更新）_

- 最近更新: _{date}_

---

## DO NOT

- ❌ Use structured data formats (JSON, databases) for storage
- ❌ Skip the reasoning chain in estimates
- ❌ Record tasks without actual execution time
- ❌ Over-engineer the estimation — keep it simple and transparent
- ❌ Delete historical records — they are valuable for learning
