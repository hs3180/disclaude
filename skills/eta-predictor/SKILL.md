---
name: eta-predictor
description: Task ETA prediction and recording system. Use when user asks for time estimation, "ETA", "预计时间", "多久能完成", "how long", "task record", or says keywords like "记录任务", "任务耗时", "eta". Analyzes historical task records to predict completion time for new tasks.
argument-hint: [record|predict|learn|stats] [task description]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# ETA Predictor - Task Time Estimation System

Predict task completion time based on historical records and learned rules.

## When to Use This Skill

**Use this skill for:**
- Estimating how long a task will take
- Recording completed task execution details for future predictions
- Learning from historical task data to improve estimates
- Viewing task execution statistics

**Keywords**: "ETA", "预计时间", "多久", "how long", "task record", "记录任务", "任务耗时"

## Core Principle

**Use Markdown-based unstructured storage.** Task records are free-form Markdown that capture the reasoning process behind estimates, making them transparent and improvable over time.

---

## Storage Locations

| File | Purpose |
|------|---------|
| `.claude/task-records.md` | Historical task execution records |
| `.claude/eta-rules.md` | Learned estimation rules and patterns |

---

## Modes

### Mode: `record` (Default)

Record a completed task's execution details.

**Usage**: `/eta-predictor record [task description]` or just describe the completed task.

When a task has just been completed, record:
1. Task type and description
2. Estimated time (if one was made before)
3. Actual execution time
4. Key factors that affected duration
5. Lessons learned / retrospective

**Record Format** (append to `.claude/task-records.md`):

```markdown
## {YYYY-MM-DD} {Brief Task Title}

- **Type**: {bugfix|feature|refactoring|docs|test|chore|research}
- **Estimated Time**: {duration} (if available)
- **Actual Time**: {duration}
- **Complexity Factors**: {what made it easy/hard}
- **Retrospective**: {what to remember for future estimates}
```

### Mode: `predict`

Predict ETA for a new task.

**Usage**: `/eta-predictor predict [task description]`

**Prediction Process**:

1. **Read** `.claude/eta-rules.md` for baseline rules and multipliers
2. **Search** `.claude/task-records.md` for similar historical tasks
3. **Analyze** the new task's characteristics (type, complexity factors)
4. **Generate** prediction with full reasoning chain

**Output Format**:

```markdown
## ETA Prediction

**Estimated Time**: {duration}
**Confidence**: {High|Medium|Low}

**Reasoning**:
1. Task type: {type}, baseline {duration} from eta-rules
2. Complexity factors: {factors}
3. Similar historical tasks: {references}
4. Adjustment: {explanation}

**References**:
- eta-rules.md: {specific rules applied}
- task-records.md: {similar task entries}
```

### Mode: `learn`

Analyze historical records and update estimation rules.

**Usage**: `/eta-predictor learn`

**Learning Process**:

1. **Read** all task records from `.claude/task-records.md`
2. **Identify patterns**:
   - Which task types are consistently underestimated/overestimated
   - New complexity factors discovered from retrospectives
   - Average actual times by task type
3. **Update** `.claude/eta-rules.md`:
   - Adjust baseline times based on actual data
   - Add new experience rules from retrospectives
   - Update bias analysis section
4. **Log** what was learned and why

### Mode: `stats`

Show task execution statistics.

**Usage**: `/eta-predictor stats`

Display summary statistics from task records:
- Total tasks recorded
- Average time by task type
- Estimation accuracy (estimated vs actual)
- Most common complexity factors
- Recent task history

---

## Initialization

When this skill is invoked for the first time:

1. Check if `.claude/task-records.md` exists
2. If not, create it from the template at [templates/task-records.md](templates/task-records.md)
3. Check if `.claude/eta-rules.md` exists
4. If not, create it from the template at [templates/eta-rules.md](templates/eta-rules.md)

---

## Task Type Classification

| Type | Description | Typical Range |
|------|-------------|---------------|
| `bugfix` | Bug fixing | 15-60 min |
| `feature-small` | Single feature point | 30-90 min |
| `feature-medium` | Multi-component feature | 2-6 hours |
| `feature-large` | Major feature with architecture changes | 1-3 days |
| `refactoring` | Code restructuring | Varies widely |
| `docs` | Documentation | 15-60 min |
| `test` | Test writing/fixing | 15-60 min |
| `chore` | Maintenance tasks | 5-30 min |
| `research` | Investigation/analysis | 30 min - 2 hours |

---

## Complexity Multipliers

When analyzing a task, apply these multipliers to the baseline time:

| Factor | Multiplier | Examples |
|--------|------------|----------|
| Security/auth involved | × 1.5 | Authentication, authorization, encryption |
| Core module changes | × 2.0 | Modifying core architecture or shared utilities |
| Existing reference code | × 0.7 | Similar patterns already in codebase |
| Third-party API integration | × 1.5 + debug time | External service calls, webhooks |
| Async/state management | × 1.5 | Race conditions, event handling |
| Cross-platform concern | × 1.3 | Needs to work on multiple platforms |
| No test coverage area | × 1.3 | Untested code, higher regression risk |
| Well-defined requirements | × 0.8 | Clear spec, known patterns |
| First time doing this | × 1.5 | No prior experience with this type of task |

Multipliers are **additive**, not multiplicative:
- Base 60 min + auth (×1.5) + core module (×2.0) = 60 × 1.5 × 2.0 = 180 min

---

## Confidence Levels

| Level | Criteria |
|-------|----------|
| **High** | 3+ similar tasks in history, consistent actual times, clear requirements |
| **Medium** | 1-2 similar tasks, or well-understood task type with some uncertainty |
| **Low** | No similar tasks, novel task type, unclear scope, or high uncertainty |

---

## Integration Points

### After Task Completion

When a deep task or scheduled task completes, use `record` mode to capture:
- What was the original estimate (if any)
- What was the actual time spent
- What factors affected the duration
- What was learned for future estimates

### Before Task Start

When a new task is being planned, use `predict` mode to:
- Provide a time estimate with reasoning
- Identify potential complexity factors
- Reference similar past tasks

### Periodic Learning

Use `learn` mode periodically (e.g., after every 5-10 completed tasks) to:
- Refine estimation rules based on accumulated data
- Update baseline times
- Discover new patterns

---

## Example Interactions

### Example 1: Predicting a New Task

**User**: `/eta-predictor predict 添加用户头像上传功能`

**Agent Process**:
1. Read `.claude/eta-rules.md` → baseline for `feature-small` is 30-90 min
2. Search `.claude/task-records.md` → find similar "图片上传" task took 55 min
3. Analyze: involves file upload (third-party API ×1.5), has reference code (×0.7)
4. Calculate: baseline 60 min × 1.5 × 0.7 = 63 min

**Output**:
```
## ETA Prediction

**Estimated Time**: ~60 分钟
**Confidence**: Medium

**Reasoning**:
1. Task type: feature-small, baseline 30-90 分钟
2. 涉及文件上传（第三方 API）→ × 1.5
3. 有参考代码可借鉴 → × 0.7
4. 历史相似任务 "图片上传功能" 实际耗时 55 分钟
5. 综合判断: ~60 分钟

**References**:
- eta-rules.md: "Third-party API integration" rule
- task-records.md: 2024-03-09 添加图片上传功能 (55 min)
```

### Example 2: Recording a Completed Task

**User**: `/eta-predictor record 刚完成了登录模块重构，花了 45 分钟`

**Agent Process**:
1. Ask: "之前的估计时间是多久？" (if not mentioned)
2. Append to `.claude/task-records.md`

### Example 3: Learning from History

**User**: `/eta-predictor learn`

**Agent Process**:
1. Read all records
2. Analyze patterns
3. Update `.claude/eta-rules.md`
4. Report what was learned

---

## DO NOT

- Use structured databases or JSON for task storage (use Markdown)
- Make predictions without reading historical data first
- Skip the reasoning process in predictions
- Overwrite existing records (always append)
- Predict with unrealistically high confidence on first use
