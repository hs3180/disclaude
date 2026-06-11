---
name: loop
description: "Loop — Ralph Loop autonomous task execution. Creates a LOOP.md with checkbox items, Feishu group, and triggers iterative task completion via Loop Runner. Use when user wants autonomous task execution, iterative coding, or any multi-step task that benefits from a loop pattern. Keywords: 'loop task', '循环任务', 'autonomous loop', 'ralph loop', '循环执行', 'loop'."
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# Loop — Ralph Loop Autonomous Task Execution

初始化一个自主循环任务：解析用户需求 → 写 LOOP.md → 创建执行群 → 记录映射 → 确认返回。

**适用于**: 循环任务、自主执行、多步骤任务 | **不适用于**: 一次性对话（用普通 chat）、定时任务（用 schedule）

## When to Use

- 用户要求执行多步骤任务（代码重构、批量操作、研究项目等）
- 任务可以被拆解为可独立执行的步骤
- 用户希望 Agent 自主推进，不需要逐步指导

## Single Responsibility

- ✅ Parse user request and create LOOP.md with checkbox items
- ✅ Create a Feishu execution group
- ✅ Trigger agent via `push_to_agent` with execution instructions
- ✅ Record mapping in `workspace/bot-chat-mapping.json`
- ✅ Return immediately — non-blocking by design
- ❌ DO NOT wait for task completion
- ❌ DO NOT create scheduled tasks
- ❌ DO NOT modify existing schedules

## Context Variables

When invoked, you receive:
- **Chat ID**: Source chat where the loop request was made
- **Message ID**: The triggering message ID
- **Sender Open ID**: The user who requested the loop

## Workflow

### Step 1: Parse User Request → Write LOOP.md

Analyze the user's request and extract:
- **Task description**: What needs to be done
- **Goal**: Desired outcome
- **Constraints**: Any limitations or requirements
- **Configuration**:
  - `max_duration`: Maximum execution time (default: 2h)
  - `max_consecutive_failures`: Max consecutive failures before stop (default: 3)

Generate a filesystem-safe slug from the task title. Create working directory and write LOOP.md:

```bash
SLUG=$(echo "{task title}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
WORK_DIR="${DISCLAUDE_WORKSPACE_DIR:-/data/workspace}/loop-${SLUG}"
mkdir -p "$WORK_DIR"
```

Write `$WORK_DIR/LOOP.md`:

```markdown
# {Task Title}

## Configuration
- **max_duration**: 2h
- **max_consecutive_failures**: 3

## Goal
{Outcome description}

## Constraints
{Limitations}

## TODO
- [ ] {Step 1 — agent decomposes from task description}
- [ ] {Step 2}
- [ ] {Step N}

## Progress Log
> Agent appends a brief record here after completing each step
```

### Step 2: Create Feishu Group + push_to_agent

Create an execution group for the loop:

```bash
lark-cli im +chat-create --name "Loop: {topic}" --description "自主循环任务: {topic}" --users "{sender_open_id}"
```

Parse the response to extract the new group's `chatId`.

Then trigger the loop agent via `push_to_agent`:

```
push_to_agent(chatId: "{new group chatId}", message: "
You are a loop execution agent.

## Execution Paradigm

1. Read {WORK_DIR}/LOOP.md
2. Check elapsed > max_duration → stop, notify timeout
3. Find the next unchecked TODO item
4. Execute it
5. Check the item off (update LOOP.md)
6. Append a brief record in the 'Progress Log' section
7. Check consecutive failures >= max_consecutive_failures → stop, notify
8. If more unchecked items remain → continue to next step
9. All complete → send completion notification to group chat

## Error Handling

- Step failure → mark ~[x]~, record reason, skip to next
- Do not retry failed steps
- Tool call exception → treat as failure, record exception info

## Configuration Awareness

- One tick does one thing only
- Do not create or modify schedules
- Do not create new scheduled tasks

Working directory: {WORK_DIR}
")
```

### Step 3: Record Mapping

Append the new group to `workspace/bot-chat-mapping.json`:

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

Add entry with key `loop-{slug}`:

```json
{
  "loop-{slug}": {
    "chatId": "oc_xxx",
    "createdAt": "{ISO timestamp}",
    "purpose": "loop-{slug}",
    "topic": "{task title}",
    "creatorChatId": "{source chatId}",
    "workDir": "{WORK_DIR}",
    "status": "active"
  }
}
```

Write atomically (temp file + rename).

### Step 4: Confirm and Return

Report to the **source chat** that the loop has been initialized:

> 已创建循环任务「{topic}」，执行群已创建。Agent 将自主执行 {N} 个步骤。
>
> 工作目录: `{WORK_DIR}`
> 待办事项预览:
> - [ ] {Step 1}
> - [ ] {Step 2}
> - ...

**Do NOT wait for execution** — return immediately.

## Error Handling

| Error | Action |
|-------|--------|
| `lark-cli` not in PATH | Report error: "lark-cli 未安装，无法创建执行群" |
| Work directory exists | Append numeric suffix: `loop-{slug}-2` |
| Group creation fails | Do not proceed, report error |
| Mapping write fails | Non-critical warning (group was created) |
| `push_to_agent` fails | Report warning; group exists but agent not initialized |

## Design Principles

1. **Non-blocking**: Return to source chat immediately after initialization
2. **`push_to_agent` for execution**: Agent receives instructions via MCP tool
3. **LOOP.md is the contract**: Agent reads/writes progress in LOOP.md
4. **No schedule dependency**: Loop execution is driven by the agent, not cron
5. **Idempotent**: Check mapping before creating (avoid duplicates)
6. **Cache is rebuildable**: `bot-chat-mapping.json` can be reconstructed

## References

- `skills/start-discussion/SKILL.md` — Similar group creation + mapping pattern
- Issue #4039 — Loop System parent issue
- Issue #4063 — Loop Runner execution engine (Phase 0)
