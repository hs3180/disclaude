---
name: loop-schedule-init
description: "Loop Schedule initialization — create work directory, state file, Feishu group, and register schedule for loop-driven agent tasks. Use when user wants to set up a recurring autonomous task that executes step-by-step via schedule ticks. Keywords: 'loop task', '循环任务', 'autonomous loop', 'loop schedule', '循环执行'."
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# Loop Schedule Init — 初始化循环执行环境

为 loop schedule 任务创建完整的执行环境：工作目录、状态文件、飞书群聊、schedule 注册。类似 `start-discussion`，但额外创建状态文件和注册 schedule task。

**适用于**: 循环执行任务、自主研究、持续监控 | **不适用于**: 一次性任务、普通讨论群（用 start-discussion）

## When to Use

- 用户描述一个需要循环/逐步执行的自主任务
- 需要创建 schedule 驱动的 loop 执行环境（如：异步研究、持续监控、迭代分析）
- 任务适合拆分为多个 tick 执行，每个 tick 完成一个步骤

## Single Responsibility

- ✅ Create isolated work directory with STATE.md
- ✅ Create Feishu group for progress updates and user feedback
- ✅ Inject system prompt via `push_to_agent`
- ✅ Register schedule task referencing loop.schedule.template.md
- ✅ Record mapping in bot-chat-mapping.json
- ✅ Return immediately — non-blocking by design
- ❌ DO NOT execute any loop steps (that's the schedule's job)
- ❌ DO NOT wait for schedule execution
- ❌ DO NOT create schedules from within a scheduled task (anti-recursion)

## Context Variables

When invoked, you receive:
- **Chat ID**: Source chat where the loop request originated
- **Message ID**: The triggering message ID
- **Sender Open ID**: The user who requested the loop task

## Workflow

### Step 1: Parse User Request

Extract from the user's message:

1. **Task description**: What the loop task should accomplish
2. **Goal**: The desired outcome
3. **Constraints**: Any restrictions (time, resources, scope)
4. **Schedule frequency**: How often ticks should run (default: `*/5 * * * *` = every 5 minutes)
5. **Scene type**: The scenario (research, monitoring, analysis, etc.) — used to select system prompt scene layer

Generate a filesystem-safe **slug** from the task description (lowercase, hyphens, max 32 chars).

### Step 2: Create Isolated Work Directory

```bash
WORK_DIR="${DISCLAUDE_WORKSPACE_DIR:-$(pwd)}/loop-{slug}"
mkdir -p "$WORK_DIR"
```

Verify the directory doesn't already exist. If it does, append a numeric suffix.

### Step 3: Initialize STATE.md

Create `{WORK_DIR}/STATE.md` with initial state:

```markdown
---
status: planning
phase: initial
tickCount: 0
createdAt: {ISO timestamp}
updatedAt: {ISO timestamp}
task: {task description}
goal: {desired outcome}
scheduleSlug: {slug}
---

## 待办

- [ ] Define execution plan
- [ ] {first concrete step inferred from task description}

## 备注

{any constraints or notes from user}
```

### Step 4: Create Feishu Group

Use `lark-cli` to create a new Feishu group for progress updates:

```bash
lark-cli im +chat-create --name "Loop: {topic}" --description "循环执行任务: {task description}" --users "{sender_open_id}"
```

**Parse the response** to extract the new group's `chatId` (format: `oc_xxx`).

If `lark-cli` is not available, report the error and stop.

### Step 5: Inject System Prompt via `push_to_agent`

Use the `push_to_agent` MCP tool to inject the loop execution system prompt into the new group's agent.

The system prompt is a combination of:

**Universal layer** (all loop tasks):
```
你是一个 loop 执行 agent。每次被触发时，你执行一个步骤。

## 执行范式

1. 读取 STATE.md 获取当前状态
2. 检查 status 是否为 completed 或 error
3. 如果还在执行中，根据 phase 确定下一步操作
4. 执行一个步骤（5-15 分钟内完成）
5. 更新 STATE.md（tickCount +1, updatedAt 更新）
6. 如果任务完成，设置 status=completed 并禁用 schedule

## 重要约束
- 一个 tick 只做一件事
- 不要创建或修改其他 schedule
- 每次执行完毕后输出简短状态摘要
```

**Scene layer** (append based on scene type):

For **research** scenes:
```
## 场景：研究助手
当前研究任务：{task description}
研究阶段：planning → gathering → analyzing → reporting → completed
每次被触发时，读取 STATE.md 获取当前研究状态，执行下一个待办研究步骤。
```

For **monitoring** scenes:
```
## 场景：监控任务
当前监控目标：{task description}
监控阶段：setup → watching → alerting → reporting → completed
每次被触发时，检查监控目标状态，如有变化记录并通知。
```

For other scenes, generate an appropriate scene layer based on the task description.

```
push_to_agent(chatId: "{new group chatId}", message: "{universal layer}\n\n{scene layer}\n\n工作目录: {WORK_DIR}\n\n开始执行你的第一个 tick。")
```

### Step 6: Register Schedule Task

Create a SCHEDULE.md file for the loop task:

```bash
SCHEDULE_DIR="${DISCLAUDE_WORKSPACE_DIR:-$(pwd)}/schedules/loop-{slug}"
mkdir -p "$SCHEDULE_DIR"
```

Write `$SCHEDULE_DIR/SCHEDULE.md`:

```markdown
---
name: "Loop: {task description (short)}"
cron: "{schedule frequency}"
enabled: true
blocking: true
chatId: "{new group chatId}"
createdAt: {ISO timestamp}
---

# Loop: {task description}

你是一个 loop 执行 agent。请按以下流程执行本次 tick：

## 执行步骤

1. 读取状态文件：`{WORK_DIR}/STATE.md`
2. 检查 `status` 字段：
   - 如果 `completed`：禁用此 schedule（设置 enabled=false），发送完成通知，结束
   - 如果 `error`：评估是否可恢复，否则禁用 schedule，结束
3. 根据 `phase` 和待办列表，执行**一个**步骤
4. 更新 STATE.md：
   - `tickCount` +1
   - `updatedAt` 更新为当前时间
   - 标记已完成的待办项
   - 如阶段完成，推进 `phase`
5. 如有关键进展，通过 send_card 推送进度
6. 输出简短状态摘要

## 约束

- 一个 tick 只做一件事
- 不要创建新的 schedule
- 不要修改其他 schedule
- 步骤粒度：5-15 分钟

## 工作目录

`{WORK_DIR}`

## 完成条件

当所有待办完成时：
1. 设置 STATE.md 中 `status=completed`
2. 设置本文件 `enabled=false`
3. 发送完成通知到群聊
```

### Step 7: Record Mapping

Append the new group to `workspace/bot-chat-mapping.json`:

```bash
cat "${DISCLAUDE_WORKSPACE_DIR:-$(pwd)}/bot-chat-mapping.json" 2>/dev/null || echo "{}"
```

Add entry:

```json
{
  "loop-{slug}": {
    "chatId": "{new group chatId}",
    "workDir": "{WORK_DIR}",
    "scheduleSlug": "loop-{slug}",
    "createdAt": "{ISO timestamp}",
    "purpose": "loop-execution"
  }
}
```

Write atomically (temp file + move).

### Step 8: Confirm and Return

Report to the **source chat**:

> 已创建循环执行环境「{task description}」
> - 工作目录: `{WORK_DIR}`
> - 执行群聊: {group link}
> - 调度频率: {schedule frequency}
>
> Agent 已启动第一个 tick。你可以在执行群中查看进度和提供反馈。

**Do NOT wait** for any schedule execution.

## Error Handling

| Error | Action |
|-------|--------|
| `lark-cli` not in PATH | Report: "无法创建执行群，lark-cli 未安装" |
| Work directory exists | Append numeric suffix |
| Group creation fails | Do not create schedule or mapping |
| `push_to_agent` fails | Group created but agent not initialized — report warning |
| Schedule file write fails | Group created, report error |
| Mapping write fails | Non-critical, report warning |

## Design Principles

1. **Generic initialization**: Not bound to any specific scene — scene specialization via system prompt
2. **Non-blocking**: Return immediately after setup
3. **Idempotent**: Check for existing directories/mappings before creating
4. **Composable**: After init, execution is driven by schedule template + system prompt
5. **Reuse existing infra**: lark-cli, schedule skill, push_to_agent — no new infrastructure

## Integration with Other Components

| Component | Relationship |
|-----------|-------------|
| `loop.schedule.template.md` | Defines tick execution paradigm (referenced by SCHEDULE.md) |
| `start-discussion` | Similar pattern but without state file and schedule registration |
| `schedule` skill | Manages schedule CRUD; loop-init creates a schedule using its conventions |
| `agentic-research` SKILL.md | Provides research methodology guide (used by research scene loops) |
