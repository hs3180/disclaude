---
name: eta-predictor
description: Predict task completion time (ETA) and record task history using Markdown-based free-form storage. Use when user asks for time estimates, task ETA, completion prediction, or says keywords like "ETA", "预计时间", "多久完成", "要多久", "time estimate", "completion time", "任务记录". Also use after completing a development task to record its actual execution time for future predictions.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Task ETA Predictor

Predict task completion time based on historical records and estimation rules, using non-structured Markdown free-form storage.

## When to Use This Skill

**Use this skill for:**
- Predicting how long a task will take to complete
- Recording task execution history after completion
- Updating estimation rules from experience
- Reviewing past task performance

**Keywords**: "ETA", "预计时间", "多久完成", "要多久", "time estimate", "completion time", "任务记录", "预估", "估计时间"

## Core Principle

> **Use non-structured Markdown free-form storage, NOT structured databases or APIs.**
> - Task records are stored as Markdown documents
> - Estimation rules are maintained as editable Markdown files
> - Records include full reasoning process for review and improvement

---

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx", if available)

---

## Storage Locations

| File | Purpose | Path |
|------|---------|------|
| Task Records | Historical task execution log | `.claude/task-records.md` |
| ETA Rules | Estimation rules learned from experience | `.claude/eta-rules.md` |

---

## Phase 1: Task Recording

### Record After Task Completion

When a development task completes (code changes, bug fix, feature implementation), record it:

**Check if record file exists first:**
```
Read .claude/task-records.md
```

If file doesn't exist, create it with the header:
```markdown
# Task Records

Task execution history for ETA prediction. Records are in free-form Markdown format.

---
```

**Append a new record** at the end of `.claude/task-records.md`:

```markdown
## YYYY-MM-DD {Brief Task Description}

- **Type**: {bugfix|feature|refactoring|test|docs|chore|research}
- **Estimated Time**: {original estimate, or "none" if not estimated}
- **Estimation Basis**: {reasoning for the estimate, if any}
- **Actual Time**: {actual time taken}
- **Complexity Factors**:
  - {factor 1, e.g., "涉及认证逻辑"}
  - {factor 2, e.g., "需要修改核心模块"}
- **Retrospective**: {What was learned? Was the estimate accurate?}
- **Related**: {Issue/PR references if any}
```

**Recording Rules:**
- Always record **estimated time** (even if it was implicit)
- Always record **estimation basis/reasoning**
- Always record **actual time**
- Include **retrospective reflection**
- Use free-form Markdown — do NOT use structured data formats (JSON, YAML, etc.)

---

## Phase 2: ETA Learning

### Maintain Estimation Rules

After recording several tasks, update `.claude/eta-rules.md` with learned patterns.

**Check if rules file exists first:**
```
Read .claude/eta-rules.md
```

If file doesn't exist, create it:

```markdown
# ETA Estimation Rules

Estimation rules learned from task history. This file evolves over time.

---

## Task Type Baselines

| Type | Baseline Time | Notes |
|------|--------------|-------|
| bugfix | 15-30 min | Depends on reproducibility |
| feature-small | 30-60 min | Single functional point |
| feature-medium | 2-4 hours | Multiple components |
| refactoring | varies | Depends on impact scope |
| test | 15-45 min | Unit test writing |
| docs | 15-30 min | Documentation updates |

## Experience Rules

1. **Tasks involving auth/security** -> baseline × 1.5
2. **Modifying core modules** -> baseline × 2
3. **Having reference code available** -> baseline × 0.7
4. **Third-party API integration** -> baseline × 1.5 + debugging time
5. **Unfamiliar codebase area** -> baseline × 1.3

## Bias Analysis

- **Underestimated scenarios**: Async logic, state management, cross-module refactoring
- **Overestimated scenarios**: Simple CRUD operations, configuration changes

## Rule Sources

- Each rule should reference the task record it was derived from
```

### Learning Process

When updating rules:

1. **Read all task records** from `.claude/task-records.md`
2. **Identify patterns**:
   - Which task types are consistently underestimated/overestimated?
   - What complexity factors cause the biggest time increases?
   - Are there new patterns that should become rules?
3. **Update the rules file**:
   - Add new experience rules with source references
   - Adjust baseline times based on actual data
   - Update bias analysis section

---

## Phase 3: ETA Prediction

### Prediction Workflow

```
New task description
    ↓
1. Analyze task type and keywords
    ↓
2. Read eta-rules.md for relevant rules
    ↓
3. Search task-records.md for similar tasks
    ↓
4. Synthesize rules + similar tasks + current context
    ↓
5. Generate ETA prediction (with reasoning)
```

### Step 1: Analyze the Task

Determine:
- **Task type**: bugfix, feature-small, feature-medium, refactoring, test, docs, etc.
- **Complexity factors**: auth/security, core modules, third-party APIs, unfamiliar code, etc.
- **Scope**: files affected, modules touched

### Step 2: Consult Rules

Read `.claude/eta-rules.md` and extract:
- Baseline time for the task type
- Applicable experience rule multipliers
- Known bias patterns

### Step 3: Find Similar Tasks

Search `.claude/task-records.md` for tasks with similar:
- Type (bugfix, feature, etc.)
- Complexity factors
- Scope (similar modules/files)

### Step 4: Generate Prediction

Output in this format:

```markdown
## ETA Prediction

**Task**: {task description}
**Type**: {task type}
**Estimated Time**: {prediction}

**Confidence**: {High/Medium/Low}

**Reasoning**:
1. Task type: {type}, baseline time {baseline}
2. Complexity factors: {list applicable factors and multipliers}
3. Similar historical tasks: {reference similar records}
4. Context adjustments: {any current-context factors}

**Reference**:
- Rule: "{rule name}" from eta-rules.md
- Similar task: {date} {task name} (actual: {time})
```

### Confidence Levels

| Level | Criteria |
|-------|----------|
| **High** | 3+ similar tasks in history, consistent patterns |
| **Medium** | 1-2 similar tasks, or clear rule match |
| **Low** | No similar tasks, estimation based on baselines only |

---

## Quick Reference

### When Asked "How long will X take?"

1. Read `.claude/eta-rules.md` for baselines and rules
2. Search `.claude/task-records.md` for similar past tasks
3. Apply rules and generate prediction with reasoning
4. Output prediction in the standard format above

### After Completing a Task

1. Append task record to `.claude/task-records.md`
2. If significant new patterns found, update `.claude/eta-rules.md`
3. Include retrospective analysis in the record

---

## Integration with Development Workflow

### Automatic Recording

After a development task (deep-task, issue solver, etc.) completes:
- Record the task type, estimated vs actual time
- Include complexity factors identified during execution
- Write retrospective comparing estimate to reality

### Before Starting a Task

When user asks about ETA for a planned task:
- Analyze task description
- Consult rules and history
- Provide prediction with confidence level
- Note assumptions and risks

---

## DO NOT

- Use structured data formats (JSON, YAML, databases) for storing task records
- Create programmatic modules for pattern detection — use LLM prompt-based analysis
- Make predictions without consulting historical records
- Skip the reasoning process in predictions
- Record tasks without retrospective reflection
