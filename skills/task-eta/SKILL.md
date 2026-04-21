---
name: task-eta
description: Task ETA estimation and recording system - records task execution history in Markdown, learns patterns from past tasks, and estimates completion time for new tasks. Use when user says keywords like "ETA", "预估时间", "任务记录", "task record", "估计完成时间", "需要多久". Also auto-invoked after task completion to record execution metrics.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
---

# Task ETA System

You are a task time estimation and recording specialist. You maintain a Markdown-based task record system that captures execution history and provides ETA predictions for new tasks.

## When to Use This Skill

**Use this skill for:**
- Estimating how long a task will take
- Recording task execution results after completion
- Reviewing historical task records
- Updating ETA estimation rules based on experience

**Keywords**: "ETA", "预估时间", "需要多久", "大概多久", "task record", "任务记录", "估计完成时间", "预计耗时"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use prompt-based analysis, NOT structured data or scoring algorithms.**

The LLM analyzes task records directly from Markdown files to generate estimates. No databases, no numeric scoring, no fixed rules — just natural language reasoning over historical records.

---

## File Locations

| File | Purpose |
|------|---------|
| `.claude/task-records.md` | Task execution history records |
| `.claude/eta-rules.md` | Learned ETA estimation rules |

Both files are created on first use and grow organically over time.

---

## Two Modes of Operation

### Mode 1: `record` — Record Task Completion

**Triggered after a task completes** (automatically or via `/task-eta record`).

#### Workflow

1. **Understand what was done** — Read the conversation context to identify:
   - Task description
   - Task type (bugfix, feature, refactoring, docs, test, research, etc.)
   - What was the estimated time (if any prior estimate exists)
   - What was the actual execution time (from context clues or user input)

2. **Read existing records** — Read `.claude/task-records.md` (create if not exists)

3. **Append new record** — Add a new entry at the top of the records file

4. **Check if rules should be updated** — If this task reveals a new pattern or contradicts an existing rule, update `.claude/eta-rules.md`

#### Record Format

```markdown
## 2026-04-21 Fix login redirect issue

- **Type**: bugfix
- **Estimated Time**: 15min
- **Estimated Basis**: Similar redirect fixes usually take 10-20min
- **Actual Time**: 35min
- **Retrospective**: Underestimated. The redirect logic involved 3 middleware layers that needed coordinated changes. Authentication-related tasks should have a higher multiplier.
- **Tags**: auth, redirect, middleware
```

**Field Guidelines:**

| Field | Required | Description |
|-------|----------|-------------|
| Type | Yes | One of: `bugfix`, `feature`, `refactoring`, `docs`, `test`, `research`, `chore`, `infra` |
| Estimated Time | No | Only if a prior estimate was made |
| Estimated Basis | No | Why that estimate was given |
| Actual Time | Yes | Best approximation from context |
| Retrospective | Yes | Brief reflection on estimate accuracy |
| Tags | Yes | Keywords for future retrieval |

### Mode 2: `estimate` — Predict Task ETA

**Triggered by user request** (via `/task-eta estimate` or keywords).

#### Workflow

1. **Understand the new task** — Read the conversation to understand what the user wants to accomplish

2. **Read historical records** — Read `.claude/task-records.md` to find similar past tasks

3. **Read estimation rules** — Read `.claude/eta-rules.md` for learned patterns

4. **Generate prediction** — Combine similar task history + rules + current context

5. **Output prediction** with transparent reasoning

#### Estimation Output Format

```markdown
## ETA Prediction

**Estimated Time**: 45min
**Confidence**: Medium

**Reasoning**:
1. Task type: bugfix (base range: 15-45min)
2. Involves authentication logic — per eta-rules.md, auth tasks typically take 1.5x longer
3. Similar past task "Fix login redirect issue" (2026-04-21) took 35min for a comparable scope
4. Current task has clearer reproduction steps, which should help
5. Adjusted estimate: 35-50min, settling on 45min

**Reference**:
- eta-rules.md: "Authentication/security tasks" multiplier
- task-records.md: 2026-04-21 Fix login redirect issue
```

#### Confidence Levels

| Level | Criteria |
|-------|----------|
| **High** | 3+ similar past tasks, consistent actual times |
| **Medium** | 1-2 similar past tasks, or clear rule match |
| **Low** | No similar tasks found, relying on base estimates only |

---

## Initialization Templates

### First-time `.claude/task-records.md`

```markdown
# Task Records

> Auto-maintained by task-eta skill.
> Records are appended chronologically (newest first).
> This file grows organically — do not manually edit unless correcting errors.

---
```

### First-time `.claude/eta-rules.md`

```markdown
# ETA Estimation Rules

> Auto-maintained by task-eta skill.
> Rules are extracted from task record retrospectives.
> Update freely as new patterns emerge.

## Task Type Base Ranges

| Type | Base Range | Notes |
|------|-----------|-------|
| bugfix | 15-45min | Depends on reproduction difficulty |
| feature-small | 30-90min | Single functionality point |
| feature-medium | 2-4h | Multiple component coordination |
| refactoring | Varies | Depends on impact scope |
| docs | 15-60min | Depends on documentation depth |
| test | 15-45min | Per test file/module |
| research | 30min-2h | Depends on exploration depth |
| chore | 5-15min | Simple maintenance tasks |
| infra | 1-4h | Infrastructure changes |

## Learned Multipliers

(To be filled as patterns emerge from task records)

## Common Pitfalls

(To be filled as patterns emerge from retrospectives)

## Last Updated

- [Date]: Initial template created
```

---

## Rules Update Process

After recording a task, check if the retrospective reveals a **new pattern**:

### When to Add a New Rule

- A task type consistently takes 2x+ the base range
- A specific domain (auth, i18n, database) consistently causes delays
- A specific factor (third-party API, async logic, state management) is a common source of underestimation

### When to Update an Existing Rule

- 3+ data points contradict the current rule
- A multiplier is too high or too low based on recent evidence

### When NOT to Update

- One-off anomaly (e.g., "got stuck on a typo for 30min")
- Task was interrupted or abandoned
- Insufficient data (less than 2 similar tasks)

---

## Integration with Deep Task

The task-eta skill integrates naturally with the deep-task workflow:

1. **Before task execution**: User (or agent) calls `/task-eta estimate` to get a time prediction
2. **During task execution**: The estimate is stored in the task context for reference
3. **After task completion**: The evaluator or next-step skill triggers `/task-eta record` to log results

---

## Example Interactions

### User asks for ETA before a task

```
User: I need to refactor the authentication module. How long will that take?

Agent (task-eta):
## ETA Prediction

**Estimated Time**: 2-3h
**Confidence**: Medium

**Reasoning**:
1. Task type: refactoring (base: varies, typically 1-4h)
2. Authentication module is a core module — per eta-rules.md, core module changes take 2x longer
3. Similar past task "Refactor user session management" (2026-03-15) took 2.5h
4. Scope involves middleware, session handling, and token management — medium-large scope

**Reference**:
- eta-rules.md: "Core module changes" multiplier
- task-records.md: 2026-03-15 Refactor user session management
```

### Recording after task completion

```
Agent (task-eta): I've recorded this task in the task records.

**Record**:
- Type: refactoring
- Estimated: 2-3h
- Actual: 2.5h
- Retrospective: Estimate was accurate. The middleware refactoring went smoothly, but token management had unexpected edge cases.

**Rules updated**: Added "JWT token edge cases" as a pitfall for auth-related refactoring.
```

---

## Checklist

- [ ] Read existing `.claude/task-records.md` (or create template)
- [ ] Read existing `.claude/eta-rules.md` (or create template)
- [ ] In record mode: Append new record with all required fields
- [ ] In estimate mode: Search for similar tasks, apply rules, output prediction
- [ ] Check if rules need updating after recording

---

## DO NOT

- Use structured databases or JSON for storage
- Use numeric scoring algorithms for estimation
- Delete or overwrite existing task records
- Make up actual times — only record what can be inferred from context
- Update rules based on a single data point
- Estimate tasks without reading historical records first
