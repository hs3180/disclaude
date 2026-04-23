---
name: task-eta
description: Task ETA estimation system - records task execution data, learns estimation rules, and predicts completion times using Markdown-based storage. Use when user asks for ETA prediction, task time estimation, or says keywords like "预估时间", "ETA", "任务耗时", "预测", "task estimate". Also triggered after task completion to record execution data.
allowed-tools: [Read, Write, Edit, Glob, Grep, Bash, send_user_feedback]
---

# Task ETA Estimation System

Estimate task completion times using historical execution data stored in Markdown files. All data is stored as **unstructured Markdown** — no structured interfaces or databases.

## When to Use This Skill

**Use this skill for:**
- Predicting how long a new task will take
- Recording task execution data after completion
- Reviewing and learning from historical task patterns
- Updating ETA estimation rules

**Keywords that trigger this skill**: "预估时间", "ETA", "任务耗时", "预测时间", "task estimate", "time prediction", "多久", "多长时间"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

> **All task data is stored as free-form Markdown. No structured data interfaces.**

- Task records: `workspace/task-records.md`
- ETA rules: `workspace/eta-rules.md`
- Records contain full estimation reasoning for review and improvement
- Rules evolve naturally as Markdown documents

---

## Operating Modes

This skill has three operating modes. Detect which mode to use based on the user's request:

| Mode | Trigger | Action |
|------|---------|--------|
| **Record** | Task completed, "记录", "复盘" | Append task record to task-records.md |
| **Predict** | New task, "预估", "ETA", "多久" | Predict ETA using rules + history |
| **Learn** | "学习", "更新规则", "优化预估" | Analyze records and update rules |

---

## Mode 1: Record (Task Completion Recording)

### When to Record

Record task data in these scenarios:
1. After completing a significant task (bug fix, feature, refactor)
2. After a scheduled task execution finishes
3. When user explicitly asks to record/retrospect

### Workflow

1. **Identify task metadata** from the conversation:
   - Task type (bugfix, feature, refactor, test, docs, chore)
   - Task description (brief summary)
   - Estimated time (if there was a prediction)
   - Actual time spent (calculate from timestamps or ask user)
   - Key factors that affected duration

2. **Read existing records**:
   ```
   Read workspace/task-records.md
   ```
   If the file doesn't exist, create it with the header.

3. **Append new record** using Edit tool:
   ```markdown
   ## {YYYY-MM-DD} {Task Title}

   - **类型**: {bugfix|feature|refactor|test|docs|chore}
   - **估计时间**: {X}分钟
   - **估计依据**: {Why you estimated this time}
   - **实际时间**: {Y}分钟
   - **偏差**: {+/-Z}分钟 ({+/-P}%)
   - **复盘**: {What went well/poorly, lessons learned}
   - **关键因素**: {What made it faster/slower than expected}
   ```

### task-records.md File Format

```markdown
# 任务记录

> 记录每次任务执行的预估和实际耗时，用于改进 ETA 预测准确性。

---

## 2026-04-23 修复登录模块 Token 过期问题

- **类型**: bugfix
- **估计时间**: 20分钟
- **估计依据**: 类似之前的 Token 刷新 bug，当时花了15分钟
- **实际时间**: 35分钟
- **偏差**: +15分钟 (+75%)
- **复盘**: 低估了多设备并发 Token 过期的复杂度，需要处理竞态条件
- **关键因素**: 并发问题、竞态条件

## 2026-04-22 添加用户导出功能

- **类型**: feature
- **估计时间**: 60分钟
- **估计依据**: 需要数据查询 + 格式转换 + 文件下载，参照之前的报表功能
- **实际时间**: 55分钟
- **偏差**: -5分钟 (-8%)
- **复盘**: 估计较准确，之前的报表功能提供了好的参考
- **关键因素**: 有现成参考代码
```

---

## Mode 2: Predict (ETA Prediction)

### Workflow

1. **Read rule file**: `Read workspace/eta-rules.md` (create initial template if missing)
2. **Read history file**: `Read workspace/task-records.md` (skip if missing)
3. **Analyze the task**:
   - Identify task type from description
   - Extract keywords and complexity indicators
   - Look up matching rules in eta-rules.md
   - Find similar tasks in task-records.md
4. **Generate prediction** with full reasoning

### Prediction Output

Present the prediction to the user in this format:

```markdown
## ETA 预测

**任务**: {Task Title}
**估计时间**: {X}分钟 (约{Y}小时{Z}分钟)
**置信度**: {高|中|低}

### 推理过程

1. **任务分类**: {type}，基准时间 {range}
2. **规则匹配**: {Which rules apply and their multipliers}
3. **历史参考**: {Similar past tasks and their actual times}
4. **特殊因素**: {Any unique considerations}
5. **综合判断**: {Final reasoning}

### 参考
- 规则: {eta-rules.md section}
- 历史: {task-records.md entry}
```

### Prediction Logic

Follow this decision tree:

1. **Exact match** — If a very similar task exists in records → use that as primary reference
2. **Type match** — If same type tasks exist → average their actual times, apply rules
3. **Rule-based** — If no history match → use base time from rules, apply multipliers
4. **Default** — If no rules exist → use generic defaults:
   - bugfix: 15-45 minutes
   - feature-small: 30-90 minutes
   - feature-medium: 2-4 hours
   - refactor: varies by scope
   - test: 20-60 minutes
   - docs: 15-30 minutes

### Confidence Levels

| Level | Criteria |
|-------|----------|
| **高** | 3+ similar tasks in records + matching rules |
| **中** | 1-2 similar tasks OR type match with rules |
| **低** | No similar tasks, using defaults only |

---

## Mode 3: Learn (Rule Update)

### Workflow

1. **Read records**: `Read workspace/task-records.md`
2. **Analyze patterns**:
   - Which task types are consistently underestimated?
   - Which types are overestimated?
   - What factors correlate with longer/shorter times?
3. **Read current rules**: `Read workspace/eta-rules.md`
4. **Update rules** based on findings

### Pattern Detection Guidelines

Look for these patterns in task records:

| Pattern | Indicator | Action |
|---------|-----------|--------|
| Systematic underestimation | Actual > Estimated consistently for a type | Increase base time |
| Systematic overestimation | Actual < Estimated consistently for a type | Decrease base time |
| Missing factor | Certain keywords always appear in overruns | Add new multiplier rule |
| Improved efficiency | Recent tasks faster than older ones | Adjust base times down |

### eta-rules.md File Format

```markdown
# ETA 估计规则

> 基于历史任务数据不断进化的预估规则。

---

## 任务类型基准时间

| 类型 | 基准时间 | 备注 |
|------|---------|------|
| bugfix | 15-45分钟 | 取决于复现难度 |
| feature-small | 30-90分钟 | 单一功能点 |
| feature-medium | 2-4小时 | 需要多个组件配合 |
| feature-large | 4-8小时 | 涉及系统设计 |
| refactoring | 视范围而定 | 需要评估影响面 |
| test | 20-60分钟 | 取决于覆盖范围 |
| docs | 15-30分钟 | 简单文档 |
| chore | 10-30分钟 | 配置/维护类 |

## 经验乘数规则

1. **涉及认证/安全** → 基准时间 x1.5
2. **需要修改核心模块** → 基准时间 x2.0
3. **有现成参考代码** → 基准时间 x0.7
4. **涉及第三方 API 集成** → 基准时间 x1.5
5. **涉及异步/并发逻辑** → 基准时间 x1.8
6. **跨模块影响** → 基准时间 x1.5
7. **首次做此类任务** → 基准时间 x1.3
8. **有完整测试覆盖要求** → 基准时间 x1.4

## 历史偏差分析

- 低估场景: 涉及异步逻辑、状态管理、竞态条件
- 高估场景: 简单的 CRUD 操作、有模板可复用

## 规则更新日志

- {YYYY-MM-DD}: 初始规则创建
```

### When to Learn

- **Auto**: After every 5th task record (suggest update when records reach multiples of 5)
- **Manual**: When user asks "更新规则", "优化预估", "学习"
- **Triggered**: When prediction confidence is "低" for 3+ consecutive predictions

---

## File Management

### File Locations

| File | Path | Purpose |
|------|------|---------|
| Task Records | `workspace/task-records.md` | Historical task execution data |
| ETA Rules | `workspace/eta-rules.md` | Evolving estimation rules |

### File Creation

When a file doesn't exist, create it with the initial template (see format sections above). Both files use Markdown headers and should be easy to read and edit manually.

### File Size Management

If task-records.md grows beyond ~100 entries:
1. Keep the most recent 50 records
2. Archive older records to `workspace/task-records-archive.md`
3. Summarize patterns from archived records before moving them

---

## Integration Points

### With Task Completion

After any significant task (bug fix, feature, refactor), the agent can proactively suggest:
> "要不要记录这次任务的耗时？这样可以帮助改进未来的 ETA 预估。"

### With Scheduled Tasks

Scheduled task executions can auto-record their duration:
- Compare start/end timestamps
- Append record in task-records.md
- Periodically trigger Learn mode to update rules

### With deep-task Skill

When deep-task skill creates a Task.md, task-eta can be consulted to provide an initial ETA estimate for the task specification.

---

## Examples

### Example 1: Predict Mode

**User**: "修复飞书消息发送失败的 bug，预估一下要多久"

**Agent should**:
1. Read eta-rules.md → bugfix base: 15-45 min
2. Read task-records.md → find similar bugfixes
3. Analyze: "飞书消息发送" involves API integration → x1.5 multiplier
4. Generate prediction with reasoning

### Example 2: Record Mode

**User**: "刚才那个重构任务完成了，记录一下，估计30分钟，实际花了50分钟"

**Agent should**:
1. Read task-records.md
2. Append record with type=refactoring, estimated=30min, actual=50min
3. Add retrospective analysis

### Example 3: Learn Mode

**User**: "更新一下 ETA 规则"

**Agent should**:
1. Read all task records
2. Calculate per-type average deviation
3. Identify patterns
4. Update eta-rules.md multipliers and base times
5. Summarize changes made

---

## DO NOT

- ❌ Create structured data files (JSON, YAML databases)
- ❌ Use programmatic estimation algorithms
- ❌ Store records in code files (.ts, .js)
- ❌ Skip the reasoning process in predictions
- ❌ Predict without reading existing records first
- ❌ Create records without retrospective analysis
- ❌ Overwrite existing records — always append
