---
name: eta-estimator
description: Task ETA estimation specialist - records task execution history in Markdown, maintains evolving estimation rules, and predicts completion time for new tasks. Use when user asks for time estimates, task duration prediction, or says keywords like "ETA", "预估时间", "任务记录", "需要多久", "多久能完成", "time estimate", "eta". Also use after completing a task to record actual execution data.
allowed-tools: [Read, Write, Edit, Glob, Grep, send_user_feedback]
---

# ETA Estimator

Task time estimation specialist using Markdown-based records and evolving rules.

## When to Use This Skill

**Use this skill for:**
- Estimating how long a task will take
- Recording task execution history after completion
- Updating estimation rules based on actual vs estimated times
- Reviewing task performance patterns

**Keywords that trigger this skill**: "ETA", "预估时间", "需要多久", "多久能完成", "time estimate", "eta", "估计时间", "任务记录", "复盘"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

---

## Core Principle

**Use non-structured Markdown for all storage.** Do NOT use structured data, databases, or programmatic storage. All task records and estimation rules are stored as free-form Markdown that can evolve naturally through experience.

---

## Data Files

### task-records.md — Task Execution History

Location: `workspace/task-records.md`

Stores completed task records with estimated vs actual times.

### eta-rules.md — Evolving Estimation Rules

Location: `workspace/eta-rules.md`

Stores learned estimation rules, baseline times, and experience-based adjustments.

---

## Modes of Operation

### Mode 1: Estimate (ETA Prediction)

**Trigger**: User asks how long a task will take.

#### Step 1: Read Historical Data

1. Read `workspace/task-records.md` for historical task records
2. Read `workspace/eta-rules.md` for estimation rules

If either file doesn't exist, create them with initial templates (see File Templates below).

#### Step 2: Analyze the New Task

Analyze the task description to identify:
- **Task type**: bugfix, feature-small, feature-medium, refactoring, documentation, research, test, chore
- **Complexity factors**: authentication/security involvement, core module changes, third-party API integration, async logic, state management
- **Similar tasks**: Find comparable tasks from task-records.md

#### Step 3: Generate Prediction

Produce an ETA prediction following this format:

```markdown
## ETA 预测

**估计时间**: {time range, e.g., 30-45分钟}
**置信度**: {高/中/低}
**任务类型**: {identified type}

**推理过程**:
1. 任务类型: {type}，基准时间 {baseline range}
2. 复杂度调整: {factors and multipliers applied}
3. 参考相似任务: {similar task from records}
4. 综合判断: {final estimate}

**参考依据**:
- eta-rules.md: {specific rules referenced}
- task-records.md: {specific historical tasks referenced}
```

#### Step 4: Send Estimation

Send the prediction to the user via `send_user_feedback`.

### Mode 2: Record (Post-Completion)

**Trigger**: After a task is completed, to record actual execution data.

#### Step 1: Collect Task Information

Gather the following information (ask user if not provided):
- Task description
- Task type (bugfix, feature, refactoring, etc.)
- Estimated time (if there was a prior estimate)
- Actual time taken
- Complexity factors encountered
- Any surprises or lessons learned

#### Step 2: Append to task-records.md

Append a new record entry to `workspace/task-records.md`:

```markdown
## {YYYY-MM-DD} {Task Title}

- **类型**: {type}
- **估计时间**: {estimated time, or "无预估"}
- **估计依据**: {reasoning, if estimate was given}
- **实际时间**: {actual time}
- **偏差**: {actual - estimated, or "N/A"}
- **复盘**: {lessons learned, what was underestimated/overestimated}
```

#### Step 3: Update eta-rules.md (if applicable)

If the task reveals new patterns:
- Add new experience rules
- Adjust baseline times
- Update historical bias analysis

### Mode 3: Review (Performance Analysis)

**Trigger**: User wants to review estimation accuracy.

#### Step 1: Analyze Records

Read `workspace/task-records.md` and analyze:
- Overall estimation accuracy
- Patterns of underestimation/overestimation
- Task types with highest variance

#### Step 2: Generate Report

```markdown
## 📊 ETA 准确度报告

**总任务数**: {count}
**有预估的任务**: {count}
**平均偏差**: {percentage}

### 按类型统计

| 类型 | 任务数 | 平均偏差 | 趋势 |
|------|--------|----------|------|

### 低估最多的场景
{list}

### 估计较准的场景
{list}

### 改进建议
{list}
```

---

## File Templates

### Initial task-records.md

```markdown
# 任务记录

> 由 eta-estimator skill 维护
> 每次任务完成后追加记录，包含估计时间、实际时间和复盘

---
```

### Initial eta-rules.md

```markdown
# ETA 估计规则

> 由 eta-estimator skill 维护
> 基于历史任务经验不断进化的估计规则

---

## 任务类型基准时间

| 类型 | 基准时间 | 说明 |
|------|----------|------|
| bugfix | 15-30分钟 | 取决于复现难度和根因分析 |
| feature-small | 30-60分钟 | 单一功能点，影响面小 |
| feature-medium | 2-4小时 | 多组件配合，需要设计 |
| refactoring | 视范围而定 | 需要评估影响面和回归风险 |
| documentation | 15-45分钟 | 取决于篇幅和需要的调研 |
| research | 1-3小时 | 取决于调研深度 |
| test | 30-90分钟 | 取决于覆盖范围和 mock 复杂度 |
| chore | 10-30分钟 | 配置、依赖更新等 |

## 经验规则

### 复杂度乘数

1. **涉及认证/安全** → 基准时间 × 1.5
2. **需要修改核心模块** → 基准时间 × 2
3. **有现成参考代码** → 基准时间 × 0.7
4. **涉及第三方 API 集成** → 基准时间 × 1.5 + 调试时间
5. **涉及异步逻辑/状态管理** → 基准时间 × 1.5
6. **需要跨多文件修改** → 基准时间 × 1.3
7. ** unfamiliar codebase** → 基准时间 × 2

### 低估高发场景

- 涉及异步逻辑和并发
- 状态管理相关变更
- 跨进程/跨服务通信
- 需要处理边界情况和错误处理

### 高估高发场景

- 简单的 CRUD 操作
- 配置文件修改
- 文档更新

---

## 历史偏差分析

> 每次记录新任务后更新此部分

*暂无足够数据进行偏差分析*
```

---

## Estimation Methodology

### Step-by-Step Prediction Process

```
新任务描述
    ↓
1. 识别任务类型 → 查阅基准时间表
    ↓
2. 分析复杂度因素 → 应用乘数调整
    ↓
3. 检索相似任务 → 参考历史实际时间
    ↓
4. 综合判断 → 生成带推理过程的 ETA
    ↓
5. 标注置信度 → 基于数据量和一致性
```

### Confidence Levels

| 置信度 | 条件 |
|--------|------|
| **高** | 有 3+ 相似任务记录，偏差 < 20% |
| **中** | 有 1-2 相似任务记录，或规则覆盖较好 |
| **低** | 无相似记录，依赖基准时间估算 |

---

## Mode Detection

Determine the mode from the user's request:

| User Intent | Mode | Example |
|-------------|------|---------|
| "这个任务要多久？" | Estimate | 预估一个新任务 |
| "记录一下这个任务" | Record | 任务完成后记录 |
| "看看估计得准不准" | Review | 分析历史准确度 |

If the user's intent is ambiguous, default to **Estimate** mode.

---

## Integration with Task Workflow

This skill integrates naturally with the task workflow:

1. **Before task**: Use Estimate mode to predict ETA
2. **During task**: No action needed
3. **After task**: Use Record mode to log actual time
4. **Periodically**: Use Review mode to analyze patterns and update rules

### Automatic Recording Suggestion

After providing an ETA estimate, suggest the user come back to record actual time:

> 💡 任务完成后，告诉我实际花费的时间，我会记录下来帮助改进未来的预估准确度。

---

## Checklist

### For Estimate Mode
- [ ] Read task-records.md and eta-rules.md
- [ ] Identified task type and complexity factors
- [ ] Found similar tasks from history
- [ ] Generated prediction with reasoning process
- [ ] Sent estimation via send_user_feedback

### For Record Mode
- [ ] Collected task information (type, times, lessons)
- [ ] Appended record to task-records.md
- [ ] Updated eta-rules.md if new patterns discovered
- [ ] Confirmed record saved

### For Review Mode
- [ ] Read all task records
- [ ] Calculated estimation accuracy metrics
- [ ] Identified underestimation/overestimation patterns
- [ ] Generated improvement suggestions
- [ ] Sent report via send_user_feedback

---

## DO NOT

- Use structured data storage (JSON, database, etc.) — always use Markdown
- Make up actual execution times — only record what the user reports
- Skip the reasoning process in predictions — transparency is critical
- Overwrite historical records — always append new entries
- Estimate tasks with zero historical data at "high confidence"
- Record tasks without the复盘 (retrospective) section
