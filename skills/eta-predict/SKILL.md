---
name: eta-predict
description: Predict estimated completion time (ETA) for tasks based on historical records and rules. Use when user asks for time estimation, "how long", "ETA", "预估时间", "多久能完成", "需要多长时间". Also auto-invoked after complex tasks complete to record actual execution time.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# ETA Prediction System

Predict task completion time using historical records and accumulated rules, stored as free-form Markdown.

## Core Principle

**Use prompt-based analysis with Markdown knowledge files, NOT structured databases or complex algorithms.**

All data is stored as human-readable Markdown that the LLM can directly analyze:
- **Task records**: `.claude/task-records.md` — historical task execution data
- **ETA rules**: `.claude/eta-rules.md` — accumulated estimation rules

## When to Use This Skill

**Auto-triggered scenarios:**
- User asks "how long will this take?", "预估时间", "ETA", "多久"
- After a complex task completes (to record execution data)
- User asks to review or update estimation rules

**Keywords**: "ETA", "预估", "估计时间", "多久", "需要多长时间", "how long", "time estimate", "eta-predict"

---

## Workflow

### Mode 1: Predict ETA (when user asks for time estimation)

#### Step 1: Classify the Task

Analyze the task description and classify it:

| Type | Description | Base Time |
|------|-------------|-----------|
| `bugfix` | Fix a bug or error | 15-30 min |
| `feature-small` | Single feature point, one file change | 30-60 min |
| `feature-medium` | Multi-component feature | 2-4 hours |
| `refactoring` | Code restructuring | Varies by scope |
| `documentation` | Docs, comments, README | 15-45 min |
| `testing` | Write or fix tests | 30-90 min |
| `research` | Investigation, analysis | 30-60 min |
| `chore` | Config, dependencies, cleanup | 10-30 min |

#### Step 2: Read Historical Data

Read the knowledge files from the workspace:

```
Read .claude/task-records.md    # Historical task records
Read .claude/eta-rules.md      # Accumulated estimation rules
```

If files don't exist yet, use the default rules below.

#### Step 3: Apply Modifiers

Check the task against known modifiers:

| Modifier | Multiplier | Example |
|----------|-----------|---------|
| Involves auth/security | × 1.5 | Login, permission checks |
| Core module modification | × 2.0 | Agent system, message handling |
| Has reference code available | × 0.7 | Can copy from existing implementation |
| Third-party API integration | × 1.5 + debug time | External service calls |
| Async/state management | × 1.5 | Complex control flow |
| Cross-platform compatibility | × 2.0 | macOS/Linux/Windows |
| Well-defined requirements | × 0.8 | Clear acceptance criteria |
| Uncertain scope | × 1.5 | May need additional investigation |

#### Step 4: Find Similar Tasks

Search `task-records.md` for tasks with similar characteristics:
- Same task type
- Similar keywords in description
- Similar scope (files affected, modules touched)

#### Step 5: Generate Prediction

Output the prediction in this format:

```markdown
## ETA Prediction

**Estimated Time**: {time range, e.g. "45-60 minutes"}
**Confidence**: {High/Medium/Low}
**Task Type**: {classified type}

**Reasoning**:
1. Base type "{type}" → base time {range}
2. Modifier: {reason} → × {multiplier}
3. Similar task: "{task name}" took {actual time}
4. Context: {current situation factors}
5. Final estimate: {time}

**Reference**:
- Rule: {rule name from eta-rules.md}
- Similar task: {task from task-records.md}
```

---

### Mode 2: Record Task Completion (after task finishes)

When a complex task has been completed, record the execution data.

#### Step 1: Gather Task Information

From the conversation context, extract:
- **Task description**: What was done
- **Task type**: bugfix, feature, refactoring, etc.
- **Estimated time**: If an ETA was previously given
- **Actual time**: Time from start to completion (if determinable)
- **Files affected**: Which files were modified
- **Key challenges**: What made it easier or harder than expected

#### Step 2: Append to task-records.md

Append a new entry in this format:

```markdown
## {YYYY-MM-DD} {Brief task title}

- **Type**: {task type}
- **Estimated time**: {if available, e.g. "30 minutes"}
- **Actual time**: {if determinable, e.g. "45 minutes"}
- **Files affected**: {file list}
- **Challenges**: {what was harder/easier than expected}
- **Retrospective**: {what to remember for future estimates}
```

#### Step 3: Check for Rule Updates

After recording, analyze if any rules in `eta-rules.md` should be updated:
- Did this task reveal a new pattern?
- Was the estimate off by a consistent factor?
- Is there a new modifier that should be documented?

If updates are needed, suggest them to the user.

---

### Mode 3: Review & Update Rules

When user asks to review estimation accuracy.

#### Step 1: Read All Records

```
Read .claude/task-records.md
```

#### Step 2: Analyze Patterns

Calculate accuracy metrics:
- How many estimates were within ±20% of actual?
- Which task types are consistently underestimated?
- Which modifiers are most impactful?

#### Step 3: Suggest Rule Updates

Present findings and suggest updates to `eta-rules.md`.

---

## File Initialization

When either `.claude/task-records.md` or `.claude/eta-rules.md` does not exist, create them with initial content.

### Initial `eta-rules.md`

```markdown
# ETA Estimation Rules

> Auto-generated by eta-predict skill. Updated as experience accumulates.

## Task Type Base Times

| Type | Base Time | Notes |
|------|-----------|-------|
| bugfix | 15-30 min | Depends on reproducibility |
| feature-small | 30-60 min | Single function point |
| feature-medium | 2-4 hours | Multi-component coordination |
| refactoring | Varies | Assess impact scope first |
| documentation | 15-45 min | Depends on scope |
| testing | 30-90 min | Depends on coverage target |
| research | 30-60 min | Investigation and analysis |
| chore | 10-30 min | Config, dependencies, cleanup |

## Known Modifiers

| Modifier | Multiplier | Source |
|----------|-----------|--------|
| Involves auth/security | × 1.5 | Default |
| Core module modification | × 2.0 | Default |
| Has reference code | × 0.7 | Default |
| Third-party API integration | × 1.5 + debug | Default |
| Async/state management complexity | × 1.5 | Default |
| Cross-platform compatibility | × 2.0 | Default |
| Well-defined requirements | × 0.8 | Default |
| Uncertain scope | × 1.5 | Default |

## Bias Patterns

> Updated as task records accumulate

- No patterns yet (insufficient data)

## Rule Changelog

- {YYYY-MM-DD}: Initial rules created
```

### Initial `task-records.md`

```markdown
# Task Records

> Execution history for ETA calibration. Each entry records a completed task's estimation accuracy.

*No records yet. Records will be added as tasks complete.*
```

---

## Important Notes

1. **Files are in workspace**: Both files live in `.claude/` under the workspace directory
2. **Always append**: Never overwrite existing task records; always append new entries
3. **Be honest about confidence**: If there's no similar historical task, say confidence is Low
4. **Time ranges**: Always give a range, never a single point estimate
5. **Context matters**: The same task type can have very different durations based on context
6. **Prompt-based**: The LLM does all analysis directly from reading the Markdown files — no code logic needed

## DO NOT

- Use structured databases or JSON for storage
- Overwrite existing task records
- Give single-point time estimates (always use ranges)
- Claim high confidence without historical evidence
- Modify these rules files without user awareness
