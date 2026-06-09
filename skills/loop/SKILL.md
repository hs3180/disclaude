---
name: loop
description: "Loop — Ralph Loop autonomous task execution. Creates a LOOP.md with checkbox items, Feishu group, and schedule for iterative task completion. Use when user wants autonomous task execution, iterative coding, or any multi-step task that benefits from a loop pattern. Keywords: 'loop task', '循环任务', 'autonomous loop', 'ralph loop', '循环执行', 'loop'."
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
user-invocable: true
---

# Loop — Ralph Loop Task Execution

Autonomous task execution using the Ralph Loop pattern: one agent, one file (LOOP.md), each tick is a fresh session.

## Initialization Workflow (4 Steps)

### Step 1: Parse Requirements → Write LOOP.md

1. Understand the user's task requirements
2. Break down into **concrete, independently executable** steps
3. Write `{WORK_DIR}/LOOP.md` using the template at `skills/loop/LOOP-TEMPLATE.md`
4. Each checkbox item should be completable in a single agent tick

### Step 2: Create Feishu Group + Inject Agent

```bash
# Create group
lark-cli im +chat-create --name "Loop: {task-slug}" --chat_type group

# Inject loop agent with system prompt
push_to_agent(chatId=<new_group_id>, message=<contents of skills/loop/PROMPT.md with WORK_DIR replaced>)
```

The system prompt (PROMPT.md) instructs the agent to read LOOP.md, execute next unchecked item, check it off, and exit.

### Step 3: Register Schedule

Create schedule using the template at `skills/loop/schedule-template.md`:

```bash
# Create schedule directory
mkdir -p {DISCLAUDE_WORKSPACE_DIR}/schedules/loop-{slug}

# Write SCHEDULE.md from template
# Replace {TASK_NAME}, {CRON}, {CHAT_ID}, {WORK_DIR} placeholders
```

### Step 4: Confirm and Return

Report to the user (non-blocking):
- Loop task created
- Number of items in LOOP.md
- Schedule frequency
- Feishu group link

## Design Principles

- **Disk = state, process = tick**: No in-memory state between ticks
- **Fresh session each tick**: Zero context degradation
- **Completion = all checkboxes checked**: Objective, verifiable
- **Auto-disable on completion**: Agent outputs `<promise>DONE</promise>` → schedule disabled

## File Reference

| File | Purpose |
|------|---------|
| `skills/loop/SKILL.md` | This file — initialization skill definition |
| `skills/loop/PROMPT.md` | System prompt template injected into loop agent |
| `skills/loop/LOOP-TEMPLATE.md` | LOOP.md template for task breakdown |
| `skills/loop/schedule-template.md` | SCHEDULE.md template for schedule registration |

## Integration with Other Skills

| Skill | Relationship |
|-------|-------------|
| `schedule` | Loop creates schedules using schedule conventions |
| `start-discussion` | Similar group creation pattern, but loop adds LOOP.md + schedule |
| `agentic-research` | Can use loop as execution engine (LOOP.md contains research steps) |
| `deep-task` | DEPRECATED — loop replaces deep-task/evaluator/executor trio |
