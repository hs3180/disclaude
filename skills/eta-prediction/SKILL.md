---
name: eta-prediction
description: Task ETA estimation system - predicts task completion time using Markdown-based task records and evolving estimation rules. Use when user asks "how long will this take", "estimate time", "ETA", "任务预估", "预计时间", "ETA预测". Also triggered after task completion for record-keeping.
argument-hint: "[predict|record|review]"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, send_user_feedback
---

# Task ETA Estimation System

Predict task completion time using Markdown-based task records and evolving estimation rules.

> **Core Principle**: All data is stored as **non-structured Markdown**. No structured data formats (JSON, databases, TypeScript interfaces). The LLM reads, writes, and reasons about Markdown directly.

## When to Use This Skill

**Use this skill for:**
- Estimating how long a task will take before starting it
- Recording task completion info (estimated vs actual time)
- Reviewing historical task performance and improving estimation rules
- User asks "这个任务要多久", "预估一下时间", "how long", "ETA"

**Keywords**: "ETA", "预估", "估计时间", "任务时间", "estimate", "prediction", "task duration"

**Three modes** (specified via `$ARGUMENTS` or auto-detected):
- `predict` — Estimate time for a new task (default if user asks about time)
- `record` — Record a completed task's info (default after task completion)
- `review` — Review and update estimation rules (triggered manually or on schedule)

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Data Files

All data is stored in Markdown files under `workspace/data/`:

| File | Purpose | Created On First Use |
|------|---------|---------------------|
| `workspace/data/task-records.md` | Individual task execution records | Yes |
| `workspace/data/eta-rules.md` | Evolving estimation rules and patterns | Yes |

---

## Mode 1: `predict` — Estimate Time for a New Task

### Step 1: Read Existing Data

1. Read the estimation rules: `workspace/data/eta-rules.md`
   - If the file doesn't exist, proceed with default heuristics
2. Read the task records: `workspace/data/task-records.md`
   - If the file doesn't exist, proceed without history

### Step 2: Analyze the Task

Analyze the task description to identify:

1. **Task Type**: bugfix / feature-small / feature-medium / feature-large / refactoring / testing / documentation / research
2. **Complexity Factors**: authentication, core module changes, third-party integration, async logic, UI changes
3. **Similar Past Tasks**: Search task-records.md for tasks with similar type/keywords

### Step 3: Generate Prediction

Use the rules and similar tasks to produce an estimate:

```markdown
## ETA Prediction

**Task**: [task description]
**Estimated Time**: [X minutes / X hours]
**Confidence**: [high / medium / low]
**Based On**: [historical / similar_tasks / default]

### Reasoning Process

1. **Task Type**: [type], base time [range]
2. **Complexity Adjustment**: [factor] → [multiplier] → [adjusted range]
3. **Similar Tasks Found**: [count] past tasks
   - "[past task 1]": estimated [X]min, actual [Y]min
   - "[past task 2]": estimated [X]min, actual [Y]min
4. **Adjustment for current context**: [reasoning]
5. **Final estimate**: [time] ([confidence])

### References
- Rules: [specific rule from eta-rules.md]
- Records: [specific task entries from task-records.md]
```

### Step 4: Deliver Prediction

Send the prediction to the user using `send_user_feedback` or respond directly in the conversation.

**Important**: Store the prediction mentally (or note it in conversation) so that when the task completes, you can compare estimated vs actual.

---

## Mode 2: `record` — Record a Completed Task

### Step 1: Gather Task Info

Collect from the conversation context:
- **Task description** (what was done)
- **Task type** (bugfix, feature, refactor, etc.)
- **Estimated time** (if a prediction was made earlier)
- **Actual time** (based on start/end timestamps in conversation)
- **Key challenges** encountered during execution
- **Tools/technologies** used

### Step 2: Append to Task Records

Open `workspace/data/task-records.md` and **append** a new entry at the end.

**If the file doesn't exist**, create it with this header:

```markdown
# Task Records

> Auto-maintained by eta-prediction skill. Each entry records task execution info for future ETA predictions.
> Do NOT restructure this file — it's designed for free-form Markdown storage.

---
```

Then append the new entry:

```markdown
---

## [YYYY-MM-DD] [Task Title]

- **Type**: [bugfix / feature-small / feature-medium / feature-large / refactoring / testing / documentation / research]
- **Estimated Time**: [X minutes] (or "not estimated" if no prediction was made)
- **Estimation Basis**: [why this estimate was chosen, or "N/A"]
- **Actual Time**: [Y minutes]
- **Accuracy**: [overestimated / accurate / underestimated] (within 20% = accurate)
- **Key Work**: [brief description of what was actually done]
- **Challenges**: [what made this task harder/easier than expected]
- **Review**: [reflection on why estimate was accurate or not, and lessons learned]
- **Keywords**: [comma-separated keywords for future search: module names, technologies, patterns]

---
```

### Step 3: Update Estimation Rules (if significant pattern found)

After recording, check if this task reveals a new pattern:

1. If the estimate was significantly off (>30% error), consider updating `eta-rules.md`
2. If a new type of complexity was discovered, add a new rule
3. If multiple tasks of the same type show consistent bias, adjust the base time

**Rules update format** (append to `eta-rules.md`):

```markdown
### [YYYY-MM-DD] Update: [reason]

- **New Rule**: [description of the pattern discovered]
- **Source**: Task "[task title]" on [date]
- **Adjustment**: [how estimates should change for similar tasks]
```

---

## Mode 3: `review` — Review and Improve Rules

### Step 1: Read All Data

1. Read `workspace/data/task-records.md` — all historical records
2. Read `workspace/data/eta-rules.md` — current estimation rules

### Step 2: Analyze Accuracy

Compute overall statistics by reading the records:

| Metric | How to Compute |
|--------|---------------|
| Overall accuracy | % of tasks where actual time was within 20% of estimate |
| By task type | Average accuracy for each type |
| Common bias | Is the system consistently over/under-estimating? |
| Worst predictions | Which tasks had the largest errors? |

### Step 3: Update Rules

Based on the analysis, update `workspace/data/eta-rules.md`:

1. **Adjust base times** if systematic bias is detected
2. **Add new rules** for patterns discovered
3. **Remove outdated rules** that no longer apply
4. **Update historical bias analysis** section

### Step 4: Generate Report

```markdown
## ETA Estimation Review Report

**Review Date**: [YYYY-MM-DD]
**Period Analyzed**: [start] to [end]
**Total Tasks**: [count]

### Accuracy Summary

| Task Type | Count | Avg Accuracy | Common Bias |
|-----------|-------|-------------|-------------|
| [type] | [n] | [%] | [over/under] |

### Top Insights

1. [Insight 1 from analysis]
2. [Insight 2 from analysis]
3. [Insight 3 from analysis]

### Rules Updated

- [List of rules added/modified/removed]

### Recommendations

1. [Recommendation for improving future estimates]
2. [Recommendation for task recording]
```

Send the report to the user using `send_user_feedback`.

---

## File Templates

### `workspace/data/task-records.md` (created on first use)

```markdown
# Task Records

> Auto-maintained by eta-prediction skill. Each entry records task execution info for future ETA predictions.
> Do NOT restructure this file — it's designed for free-form Markdown storage.

---
```

### `workspace/data/eta-rules.md` (created on first use)

```markdown
# ETA Estimation Rules

> Evolving rules for task time estimation. Updated through experience and review.
> This document grows and adapts as we complete more tasks.

## Task Type Base Times

| Type | Base Time | Notes |
|------|-----------|-------|
| bugfix | 15-30 min | Depends on reproduction difficulty |
| feature-small | 30-60 min | Single feature point |
| feature-medium | 2-4 hours | Multiple components involved |
| feature-large | 4-8 hours | Cross-system changes |
| refactoring | varies | Depends on scope |
| testing | 30-90 min | Depends on coverage needed |
| documentation | 15-45 min | Depends on length |
| research | 1-3 hours | Open-ended exploration |

## Complexity Multipliers

| Factor | Multiplier | When to Apply |
|--------|-----------|---------------|
| Authentication/Security | ×1.5 | Tasks involving auth, tokens, permissions |
| Core Module Changes | ×2.0 | Changes to shared/core modules |
| Available Reference Code | ×0.7 | When similar code exists to copy from |
| Third-party API Integration | ×1.5 | External API calls + debugging |
| Async/Concurrency | ×1.5 | Race conditions, state management |
| Cross-repo Changes | ×1.3 | Changes spanning multiple packages |
| New Skill Creation | 1-3 hours | Depends on skill complexity |

## Known Bias Patterns

<!-- This section records systematic estimation biases discovered over time -->

*No patterns recorded yet. Will be updated during review mode.*

## Historical Accuracy

<!-- Updated during review mode -->

| Period | Tasks | Accuracy | Bias |
|--------|-------|----------|------|
| *(no data yet)* | | | |

---
```

---

## Integration with Other Systems

### With Task Agent (deep-task skill)
- When a task starts, invoke `eta-prediction predict` to get an estimate
- When a task completes, invoke `eta-prediction record` to log the result
- The Task.md file can include the ETA prediction

### With Scheduler
- A weekly schedule can invoke `eta-prediction review` to maintain rules
- Schedule example:
  ```markdown
  ---
  name: "ETA Rules Review"
  cron: "0 9 * * 1"
  enabled: true
  blocking: true
  chatId: "{chat_id}"
  ---
  请使用 eta-prediction skill 的 review 模式，分析过去一周的任务记录，更新估计规则。
  ```

---

## Checklist

### Predict Mode
- [ ] Read eta-rules.md (or use defaults)
- [ ] Read task-records.md for similar tasks
- [ ] Analyzed task type and complexity
- [ ] Generated prediction with reasoning
- [ ] Delivered prediction to user

### Record Mode
- [ ] Collected task info from context
- [ ] Created task-records.md if needed
- [ ] Appended new entry with all fields
- [ ] Checked for new estimation patterns
- [ ] Updated eta-rules.md if significant pattern found

### Review Mode
- [ ] Read all task records
- [ ] Read current estimation rules
- [ ] Computed accuracy statistics
- [ ] Updated rules based on analysis
- [ ] Generated and sent review report

---

## DO NOT

- ❌ Use structured data formats (JSON, TypeScript interfaces) for task records
- ❌ Create programmatic prediction algorithms (use LLM reasoning instead)
- ❌ Skip the reasoning process in predictions
- ❌ Delete or restructure existing task records (always append)
- ❌ Make predictions without referencing history (when available)
- ❌ Overwrite eta-rules.md — always append updates, keep history visible
