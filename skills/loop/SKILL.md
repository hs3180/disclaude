---
name: loop
description: "Loop — Ralph Loop autonomous task execution. Creates a LOOP.md with checkbox items, Feishu group, and schedule for iterative task completion. Use when user wants autonomous task execution, iterative coding, or any multi-step task that benefits from a loop pattern. Keywords: 'loop task', '循环任务', 'autonomous loop', 'ralph loop', '循环执行', 'loop'."
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# Loop — Ralph Loop Initialization

Initialize an autonomous loop execution environment. Parse user requirements, create a LOOP.md task tracker, set up a Feishu execution group, and kick off the first step — all without blocking the source chat.

**V3 Design: No schedule registration. Agent self-loops via async chain drive.**

**适用于**: 多步骤自主执行、迭代编码、复杂任务拆解 | **不适用于**: 简单单次任务、需要用户实时交互的任务

## When to Use

- User has a complex multi-step task that can be broken into sequential steps
- User wants autonomous execution without manual supervision
- Task benefits from iterative execution with progress tracking
- User explicitly requests loop/循环 execution

## Single Responsibility

- ✅ Parse user requirements into structured LOOP.md
- ✅ Create Feishu execution group via `lark-cli`
- ✅ Inject execution context via `push_to_agent`
- ✅ Record mapping in `bot-chat-mapping.json`
- ✅ Return immediately — non-blocking by design
- ❌ DO NOT register schedule or cron tasks
- ❌ DO NOT create SCHEDULE.md
- ❌ DO NOT wait for loop execution to complete
- ❌ DO NOT use IPC Channel for group operations — use `lark-cli` via Bash

## Context Variables

When invoked, you receive:
- **Chat ID**: Source chat where the loop task was requested
- **Message ID**: The triggering message ID
- **Sender Open ID**: The user who requested the loop
- **DISCLAUDE_WORKSPACE_DIR**: Base directory for loop work directories

## Workflow

### Step 1: Parse Requirements → Write LOOP.md

Extract from the user's message:
- **Task description**: What needs to be done
- **Goal**: Desired outcome
- **Constraints**: Limitations and requirements
- **clear_context_per_step**: Whether to reset context between steps (default: false)
- **max_duration**: Maximum total execution time (default: 2h)
- **max_consecutive_failures**: Stop threshold for consecutive failures (default: 3)

Generate a filesystem-safe slug from the task title. Create work directory:

```bash
SLUG="{filesystem-safe-slug}"
WORK_DIR="${DISCLAUDE_WORKSPACE_DIR}/loop-${SLUG}"
mkdir -p "${WORK_DIR}"
```

If the directory already exists, append a numeric suffix:

```bash
if [ -d "${WORK_DIR}" ]; then
  SUFFIX=2
  while [ -d "${DISCLAUDE_WORKSPACE_DIR}/loop-${SLUG}-${SUFFIX}" ]; do
    SUFFIX=$((SUFFIX + 1))
  done
  WORK_DIR="${DISCLAUDE_WORKSPACE_DIR}/loop-${SLUG}-${SUFFIX}"
  mkdir -p "${WORK_DIR}"
fi
```

Write LOOP.md to the work directory:

```markdown
# {任务标题}

## 配置
- **clear_context_per_step**: false
- **max_duration**: 2h
- **max_consecutive_failures**: 3
- **startedAt**: {ISO 8601 timestamp}

## 目标
{成果描述}

## 约束
{限制条件}

## 待办
- [ ] {步骤 1 — agent 根据任务描述拆解}
- [ ] {步骤 2}
- [ ] {步骤 N}

## 进度记录
> agent 每完成一个步骤后在这里追加简要记录
```

Record the `startedAt` timestamp in the configuration section for `max_duration` checking during execution.

### Step 2: Create Feishu Group + push_to_agent

Create a Feishu group for loop execution. **Always include the triggering user**:

```bash
lark-cli im +chat-create --name "Loop: {topic}" --users "{sender_open_id}"
```

**Parse the response** to extract the new group's `chatId` (format: `oc_xxx`).

If `lark-cli` is not available, report the error and stop:

```bash
lark-cli --version || echo "ERROR: lark-cli not found in PATH"
```

If group creation fails, do NOT proceed to the next step.

Once the group is created, inject the execution context via `push_to_agent`:

```
push_to_agent(chatId: "{new group chatId}", message: "
你是一个 loop 执行 agent。

## 执行范式

1. 读取 {WORK_DIR}/LOOP.md
2. 检查 elapsed > max_duration → 停止，通知超时
3. 找到下一个未勾选的待办项
4. 执行它
5. 勾掉该项（更新 LOOP.md）
6. 在「进度记录」区追加一行记录
7. 检查连续失败数 ≥ max_consecutive_failures → 停止，通知
8. 如果还有未完成项 → 继续执行下一步
9. 全部完成 → 发送完成通知到群聊

## 错误处理

- 步骤失败 → 标记 ~~[x]~~，记录原因，跳到下一个
- 不要重试失败的步骤
- 工具调用异常 → 视为失败，记录异常信息

## 配置感知

- 如果 clear_context_per_step=true：每步完成后通过 push_to_agent 触发下一步（新 session）
- 如果 clear_context_per_step=false：在同一 session 内继续执行

## 约束

- 一个 tick 只做一件事
- 不要创建或修改 schedule
- 不要创建新的定时任务

工作目录：{WORK_DIR}
")
```

**Note**: `push_to_agent` handles agent creation automatically. The agent will execute in the new group using standard messaging capabilities.

### Step 3: Record Mapping (No Schedule)

Use `bot-chat-mapping.json` to record the mapping relationship for tracking and cleanup:

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

Add an entry with key `loop-{slug}`:

```json
{
  "loop-{slug}": {
    "chatId": "oc_xxx",
    "createdAt": "{ISO timestamp}",
    "purpose": "loop-{slug}",
    "workDir": "{WORK_DIR}"
  }
}
```

Write the updated mapping atomically (write to temp file, then move):

```bash
echo '{ ... updated JSON ... }' > workspace/bot-chat-mapping.json.tmp \
  && mv workspace/bot-chat-mapping.json.tmp workspace/bot-chat-mapping.json
```

**Do NOT create SCHEDULE.md.** Do NOT register cron tasks. The loop executes via agent self-driving.

If the mapping write fails, log a warning but do not block — the mapping is a cache that can be rebuilt.

### Step 4: Confirm and Return

Report to the **source chat** that the loop has been initialized:

> 已创建循环任务「{topic}」，执行群已建立。待办列表：
> - [ ] 步骤 1
> - [ ] 步骤 2
> - [ ] 步骤 N
>
> Agent 将自主执行，完成后在执行群通知。

**Do NOT wait for any execution** — return immediately.

## lark-cli Command Reference

| Operation | Command |
|-----------|---------|
| Create group | `lark-cli im +chat-create --name "Loop: {topic}" --users "{sender_open_id}"` |
| Check availability | `lark-cli --version` |

## Error Handling

| Error | Action |
|-------|--------|
| `lark-cli` not in PATH | Report error to source chat, stop |
| Work directory exists | Append numeric suffix |
| Group creation fails | Do not proceed, report to source chat |
| Mapping write fails | Non-critical warning, continue |
| `push_to_agent` fails | Report to source chat; group created but agent not initialized |

## Design Principles

1. **No schedule registration**: V3 uses async chain drive — agent self-loops without cron
2. **Non-blocking initialization**: Return to source chat immediately after setup
3. **`push_to_agent` for bootstrapping**: Use MCP tool for agent creation + context injection
4. **Idempotent**: Check mapping table before creating (avoid duplicates)
5. **Cache is rebuildable**: `bot-chat-mapping.json` can be reconstructed from Feishu API
6. **No IPC for group ops**: Direct `lark-cli` calls via Bash

## Integration with Other Skills

| Skill | Relationship |
|-------|-------------|
| `start-discussion` | Similar group-creation pattern (purpose: `discussion`) |
| `dissolve-group` | Used to clean up loop groups after completion |
| `schedule` | Explicitly NOT used — loop is schedule-free |
| `next-step` | May be triggered after loop completion for follow-up |
