---
name: task-eta
description: Task ETA estimation system - records task execution history, estimates completion time, and maintains evolving estimation rules. Use when user asks for time estimates, wants to record task completion, or says keywords like "ETA", "预估时间", "任务记录", "多久能完成", "估计要多久", "task estimation", "time estimate", "record task".
allowed-tools: [Read, Write, Glob, Grep, Bash]
---

# Task ETA Estimation System

Estimate task completion time based on historical records and evolving rules. All data is stored as **unstructured Markdown** — no databases, no structured code modules.

## When to Use This Skill

**Use this skill for:**
- Estimating how long a task will take (ETA prediction)
- Recording a completed task's execution details (time, retrospective)
- Updating estimation rules based on accumulated experience
- Reviewing historical task performance

**Keywords that trigger this skill**: "ETA", "预估时间", "任务记录", "多久能完成", "估计要多久", "task estimation", "time estimate", "record task", "记录任务", "更新规则"

## Core Principle

**Use prompt-based analysis with Markdown storage, NOT structured data or code modules.**

- Task records are free-form Markdown in `.claude/task-records.md`
- Estimation rules are maintained as natural language in `.claude/eta-rules.md`
- The LLM reads, analyzes, and writes Markdown directly
- No TypeScript services, no databases, no structured interfaces

---

## Sub-Commands

This skill supports three sub-commands. Determine which one the user wants based on their input:

| Sub-Command | Trigger | Description |
|-------------|---------|-------------|
| `estimate` | "预估", "估计", "ETA", "多久", "estimate" | Predict task completion time |
| `record` | "记录", "完成", "record", "复盘" | Record a completed task |
| `update-rules` | "更新规则", "update rules", "学习" | Update estimation rules from records |

---

## Sub-Command: estimate (ETA Prediction)

### Workflow

#### Step 1: Read Historical Data

1. Read `.claude/task-records.md` for historical task records:
```
Read file: .claude/task-records.md
```

2. Read `.claude/eta-rules.md` for estimation rules:
```
Read file: .claude/eta-rules.md
```

If either file does not exist, create an initial version (see Templates section below).

#### Step 2: Analyze the Task

Given the user's task description, analyze:

1. **Task Type Classification**: What kind of task is this?
   - Common types: `bugfix`, `feature-small`, `feature-medium`, `refactoring`, `documentation`, `test`, `investigation`, `chore`
   - Consider the task scope, complexity, and affected areas

2. **Rule Matching**: Which rules from `eta-rules.md` apply?
   - Look for matching task type base times
   - Check for modifier rules (e.g., "security tasks × 1.5")
   - Consider context-specific factors

3. **Similar Task Search**: Find similar tasks in `task-records.md`
   - Match by task type, keywords, or affected components
   - Compare estimated vs actual times for similar tasks
   - Note any retrospective insights from similar tasks

#### Step 3: Generate ETA Prediction

Produce a structured prediction with full reasoning:

```markdown
## ETA 预测

**估计时间**: {estimated duration}
**置信度**: {高/中/低}

**推理过程**:
1. 任务类型: {type}，基准时间 {base time}
2. {applicable rule 1 and its effect}
3. {applicable rule 2 and its effect}
4. 参考相似任务: "{similar task description}" (实际耗时 {actual time})
5. 综合判断: {final estimate with reasoning}

**参考来源**:
- eta-rules.md: {referenced rules}
- task-records.md: {referenced similar tasks}

**注意事项**:
- {any caveats or uncertainty factors}
```

#### Step 4: Record the Estimate

**Important**: Before starting the task, record the estimate in `task-records.md` so it can be compared with actual time later.

Append a preliminary entry:
```markdown
## {YYYY-MM-DD} {Task Description}

- **类型**: {type}
- **估计时间**: {estimated duration}
- **估计依据**: {reasoning summary}
- **实际时间**: _待记录_
- **复盘**: _待记录_
```

Update this entry when the task is completed with actual time and retrospective.

---

## Sub-Command: record (Task Completion Recording)

### Workflow

#### Step 1: Collect Task Information

Gather the following from the user or conversation context:

| Field | Description | Required |
|-------|-------------|----------|
| **Task Description** | What was done | Yes |
| **Type** | Task category | Yes |
| **Estimated Time** | What was estimated before starting | Yes |
| **Estimation Basis** | Why that estimate was given | Yes |
| **Actual Time** | How long it actually took | Yes |
| **Retrospective** | What was learned, what was underestimated/overestimated | Yes |

If the estimate was already recorded in `task-records.md` (from an earlier `estimate` call), update that entry. Otherwise, append a new one.

#### Step 2: Read and Update Records

1. Read `.claude/task-records.md`
2. If a preliminary entry exists for this task (marked with "_待记录_"), update it
3. If no preliminary entry exists, append a new complete entry

**Entry Format**:
```markdown
## {YYYY-MM-DD} {Task Description}

- **类型**: {type}
- **估计时间**: {estimated duration}
- **估计依据**: {brief reasoning for the estimate}
- **实际时间**: {actual duration}
- **复盘**: {what was learned, what to adjust next time}
```

#### Step 3: Suggest Rule Update

After recording, check if the retrospective reveals a new pattern:

- If estimated time was significantly off (>30% deviation), suggest updating `eta-rules.md`
- If a new type of complexity was discovered, suggest adding a new rule
- Ask the user if they want to run `update-rules`

---

## Sub-Command: update-rules (Rule Maintenance)

### Workflow

#### Step 1: Read All Records

Read `.claude/task-records.md` and analyze all historical task records.

#### Step 2: Identify Patterns

Analyze the records to find:

1. **Estimation Accuracy by Type**: Which types are consistently underestimated/overestimated?
2. **Common Complexity Factors**: What factors cause tasks to take longer?
3. **New Rules Needed**: Are there patterns not yet captured in `eta-rules.md`?

#### Step 3: Update Rules

Update `.claude/eta-rules.md` with:

1. **Adjusted Base Times**: If a type consistently deviates, adjust the base time
2. **New Modifier Rules**: If new complexity factors are discovered
3. **New Task Types**: If unrecognized task types appear
4. **Pattern Insights**: Add to "Historical Bias Analysis" section

**Update Format** — Make targeted edits, not full rewrites. Preserve existing rules and only add/modify what the data supports.

Each rule update should reference the source task records:
```markdown
- 2026-04-04: {rule change description}，基于任务 "{task description}" 的复盘
```

---

## File Templates

### Initial `.claude/task-records.md`

If the file doesn't exist, create it with:

```markdown
# 任务记录

> 此文件由 task-eta skill 自动维护，记录每个任务的执行信息。
> 格式自由，以 Markdown 自然语言记录。

## 记录要点

- 记录之前的估计时间
- 记录估计依据/推理过程
- 记录实际执行时间
- 包含复盘反思

---
```

### Initial `.claude/eta-rules.md`

If the file doesn't exist, create it with:

```markdown
# ETA 估计规则

> 此文件由 task-eta skill 维护，记录从历史任务中学到的估计规则。
> 规则以自然语言存储，随经验积累进化。

## 任务类型基准时间

| 类型 | 基准时间 | 备注 |
|------|---------|------|
| bugfix | 15-30分钟 | 取决于复现难度 |
| feature-small | 30-60分钟 | 单一功能点 |
| feature-medium | 2-4小时 | 需要多个组件配合 |
| refactoring | 视范围而定 | 需要评估影响面 |
| documentation | 15-30分钟 | 文档更新 |
| test | 30-60分钟 | 含编写和调试 |
| investigation | 30-60分钟 | 问题排查 |
| chore | 5-15分钟 | 简单维护任务 |

## 经验规则

> 以下规则基于历史任务复盘总结，会随新数据持续更新。

（暂无经验规则，完成更多任务后将自动积累）

## 历史偏差分析

> 记录哪些类型的任务经常被低估或高估。

（暂无数据，完成更多任务后将自动分析）

## 最近更新

（暂无更新记录）
```

---

## Quality Guidelines

### Good Estimates:
- Based on historical data and explicit rules
- Include transparent reasoning process
- Reference specific similar tasks and rules
- Acknowledge uncertainty when data is insufficient

### Good Records:
- Include the estimation basis (not just the number)
- Honest retrospective (what went wrong/right)
- Specific enough to be useful for future estimates
- Free-form Markdown, not rigid templates

### Avoid:
- Making up numbers without data or reasoning
- Using structured data formats (JSON, databases)
- Skipping the retrospective step
- Ignoring similar historical tasks

---

## Examples

### Example 1: Estimating a New Task

**User**: "帮我预估一下修复这个登录 bug 需要多久"

**Skill reads** `task-records.md` and `eta-rules.md`, then outputs:

```
## ETA 预测

**估计时间**: 25分钟
**置信度**: 中等

**推理过程**:
1. 任务类型: bugfix，基准时间 15-30分钟
2. 涉及认证逻辑，但目前没有适用的经验规则（可考虑添加）
3. 参考相似任务: "2024-03-10 重构登录模块"（实际耗时 45分钟），但那次范围更大
4. 本次任务较简单（仅修复 bug，非重构），预计在基准时间范围内

**参考来源**:
- eta-rules.md: bugfix 基准时间 15-30分钟
- task-records.md: 2024-03-10 重构登录模块（45分钟，范围更大）

**注意事项**:
- 如果 bug 涉及 session/token 逻辑，可能需要额外时间
```

### Example 2: Recording a Completed Task

**User**: "任务完成了，实际花了40分钟，比预估的25分钟多了不少"

**Skill updates** `task-records.md`:

```markdown
## 2026-04-04 修复登录页面样式 bug

- **类型**: bugfix
- **估计时间**: 25分钟
- **估计依据**: bugfix 基准 15-30分钟，CSS 修复通常较简单
- **实际时间**: 40分钟
- **复盘**: 低估了样式影响的范围。bug 涉及响应式布局，需要在多个断点下测试。
  建议规则: 涉及响应式/CSS 的 bugfix 基准时间应适当增加。
```

### Example 3: Updating Rules

After several recordings, the skill identifies a pattern:

**Skill updates** `eta-rules.md`:

Adds to "经验规则":
```
1. **涉及响应式布局/CSS 的任务** → 基准时间 × 1.5
   来源: 2026-04-04 修复登录页面样式 bug（估计25分钟，实际40分钟）
```

---

## Integration with Task Workflow

This skill can be triggered at different points in the task lifecycle:

1. **Before Task Start**: User asks for ETA → `estimate` sub-command
2. **During Task**: The preliminary record is already in `task-records.md`
3. **After Task Complete**: User reports completion → `record` sub-command
4. **Periodically**: Scheduled `update-rules` to refine estimation accuracy

---

## Schedule Configuration (Optional)

To enable periodic rule updates, create a schedule:

```markdown
---
name: "ETA 规则更新"
cron: "0 20 * * 5"  # Every Friday at 8:00 PM
enabled: true
blocking: true
chatId: "{your_chat_id}"
---

请使用 task-eta skill 的 update-rules 子命令，分析 .claude/task-records.md 中的所有任务记录，更新 .claude/eta-rules.md 中的估计规则。

要求：
1. 读取所有任务记录
2. 识别低估/高估模式
3. 更新基准时间和经验规则
4. 每个更新都要引用来源任务
5. 使用 send_user_feedback 发送更新摘要
```

---

## Checklist

### For estimate:
- [ ] Read `.claude/task-records.md` for historical data
- [ ] Read `.claude/eta-rules.md` for estimation rules
- [ ] Classified task type
- [ ] Matched applicable rules
- [ ] Found similar historical tasks
- [ ] Generated prediction with full reasoning
- [ ] Recorded preliminary estimate in task-records.md

### For record:
- [ ] Collected all required fields
- [ ] Read existing task-records.md
- [ ] Updated or appended the record
- [ ] Included estimation basis and retrospective
- [ ] Suggested rule update if estimate was off

### For update-rules:
- [ ] Read all task records
- [ ] Identified estimation accuracy patterns
- [ ] Updated base times where needed
- [ ] Added new modifier rules from retrospectives
- [ ] Referenced source tasks for each change

---

## DO NOT

- Use structured data formats (JSON, databases, TypeScript services) for storage
- Make up estimates without reasoning or historical reference
- Skip recording the retrospective
- Overwrite existing rules without analyzing data
- Create rigid templates that limit free-form Markdown recording
