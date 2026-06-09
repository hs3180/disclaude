---
name: loop
description: "Loop — Ralph Loop autonomous task execution. Creates a LOOP.md with checkbox items, Feishu group, and schedule for iterative task completion. Use when user wants autonomous task execution, iterative coding, or any multi-step task that benefits from a loop pattern. Keywords: 'loop task', '循环任务', 'autonomous loop', 'ralph loop', '循环执行', 'loop'."
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# Loop — Ralph Loop Initialization Skill

Create a self-driving loop that breaks a task into checkbox items, executes them one per tick via schedule, and auto-stops when all items are done.

**Use for**: Autonomous multi-step tasks, iterative coding, long-running batch work | **Not for**: One-off questions, simple lookups, user-driven discussions

## When to Use

- User wants autonomous task execution without manual step-by-step guidance
- Multi-step task that benefits from iterative, checkpointed execution
- Long-running work that should proceed unattended (code migration, batch processing, etc.)
- User says keywords like "loop task", "循环任务", "autonomous loop", "ralph loop", "循环执行"

## Single Responsibility

- ✅ Parse user requirements into a LOOP.md with checkbox items
- ✅ Create a Feishu group for the loop agent
- ✅ Register a schedule to drive tick-by-tick execution
- ✅ Return immediately — non-blocking
- ❌ DO NOT execute tasks yourself — delegate to the loop agent
- ❌ DO NOT create or modify existing schedules beyond the loop schedule
- ❌ DO NOT wait for loop completion

## Context Variables

When invoked, you receive:
- **Chat ID**: Source chat where the loop request was made
- **Message ID**: The triggering message ID
- **Sender Open ID**: The user who requested the loop

## Workflow

### Step 1: Parse User Requirements → Write LOOP.md

Analyze the user's message and extract:
- **Task description**: What needs to be done
- **Goal**: The desired outcome
- **Constraints**: Limitations or requirements
- **Frequency** (optional): How often ticks should run (default `0 * * * *` = hourly)

Generate a filesystem-safe slug from the task title (lowercase, hyphens, no special chars).

Determine the workspace directory:
```bash
echo "${DISCLAUDE_WORKSPACE_DIR:-$(pwd)}"
```

Create the loop work directory. If it already exists, append a numeric suffix:
```bash
WORK_DIR="${DISCLAUDE_WORKSPACE_DIR:-$(pwd)}/loop-{slug}"
# If exists, try loop-{slug}-2, loop-{slug}-3, etc.
```

Write `LOOP.md` in the work directory:

```markdown
# {Task Title}

## 目标
{Outcome description}

## 约束
{Limitations}

## 待办
- [ ] {Step 1 — break down the task into concrete steps}
- [ ] {Step 2}
- [ ] {Step N}

## 进度记录
> Agent appends a brief record after completing each step
```

The checkbox items should be concrete, actionable steps that can each be completed in a single tick. Break the task into small, verifiable pieces.

### Step 2: Create Feishu Group + push_to_agent

Create a Feishu group for the loop agent:

```bash
lark-cli im +chat-create --name "Loop: {topic}" --users "{sender_open_id}"
```

Parse the response to extract the new group's `chatId` (format: `oc_xxx`).

If `lark-cli` is not available, report the error and stop:
```bash
lark-cli --version || echo "ERROR: lark-cli not found in PATH"
```

If group creation fails, do NOT create the schedule.

Inject the loop agent initialization prompt via `push_to_agent`:

```
push_to_agent(chatId: "{new group chatId}", message: "
你是一个 loop 执行 agent。

每次被触发时：
1. 读取 LOOP.md
2. 找到下一个未勾选的待办项
3. 执行它
4. 勾掉该项（更新 LOOP.md）
5. 在「进度记录」区追加一行记录
6. 输出简短状态摘要

当所有待办项都已完成时：
1. 发送完成通知到群聊
2. 输出 <promise>DONE</promise>

约束：
- 一个 tick 只做一件事
- 不要创建或修改 schedule
- 步骤失败时记录原因，跳到下一个

工作目录：{WORK_DIR}
")
```

### Step 3: Register Schedule

Create the schedule file at `{DISCLAUDE_WORKSPACE_DIR}/schedules/loop-{slug}/SCHEDULE.md`:

```markdown
---
name: "Loop: {task}"
cron: "{frequency}"
enabled: true
blocking: true
chatId: "{chatId}"
createdAt: {ISO timestamp}
---

读取并执行 {WORK_DIR}/LOOP.md 中的下一个待办项。
```

Ensure the schedules directory exists:
```bash
mkdir -p "${DISCLAUDE_WORKSPACE_DIR:-$(pwd)}/schedules/loop-{slug}"
```

### Step 4: Confirm and Return

Report to the **source chat** that the loop has been initialized:

> Loop 已初始化：{task title}
> - 工作目录：{WORK_DIR}
> - 执行频率：{frequency description}
> - 讨论群已创建
>
> Agent 将按计划自动执行待办项，全部完成后自动停止。

Record the mapping in `workspace/bot-chat-mapping.json`:

```json
{
  "loop-{slug}": {
    "chatId": "oc_xxx",
    "createdAt": "{ISO timestamp}",
    "purpose": "loop",
    "workDir": "{WORK_DIR}"
  }
}
```

**Do NOT wait** for any loop execution — return immediately.

## Error Handling

| Error | Action |
|-------|--------|
| `lark-cli` not in PATH | Report error, stop. Do not create schedule. |
| Work directory exists | Append numeric suffix (`loop-{slug}-2`, etc.) |
| Group creation fails | Report error, do not create schedule |
| Schedule write fails | Report error (group was created but not scheduled) |
| Mapping write fails | Non-critical warning (mapping is a cache) |
| Cannot parse user task | Ask user to clarify the task requirements |

## Design Principles

1. **Non-blocking**: Return to source chat immediately after setup
2. **One tick, one task**: Each schedule tick handles exactly one checkbox item
3. **Self-terminating**: Agent outputs `<promise>DONE</promise>` when all items complete → schedule auto-disables
4. **Checkpointed**: LOOP.md serves as both task list and progress log
5. **Idempotent**: Check for existing directories/mappings before creating

## Integration with Other Skills

| Skill | Relationship |
|-------|-------------|
| `schedule` | Loop creates a schedule entry; schedule system drives the ticks |
| `start-discussion` | Similar group-creation pattern; loop adds schedule on top |
| `deep-task` | Loop replaces deep-task with a simpler, schedule-driven approach |
| `dissolve-group` | Can be used to clean up loop groups after completion |
