---
name: loop
description: Loop — initializes a Ralph Loop autonomous task by creating a LOOP.md definition file (prompt + YAML params) and a dedicated Feishu execution group. The runner then reads LOOP.md each iteration. Use when user wants to set up a recurring/autonomous loop task. Keywords: "loop", "Ralph Loop", "循环任务", "autonomous loop", "loop 初始化".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Loop — 初始化器（Ralph Loop）

为一个自主循环任务创建 **LOOP.md 定义文件** + 专用飞书执行群。Runner 随后从 LOOP.md 读 prompt 驱动每轮迭代（只读、每轮重读）。

**适用于**: 初始化一个 loop（解析需求 → 建群 → 写 LOOP.md → 推首条指令）| **不适用于**: 每轮执行（runner 负责）、停止/查询 loop（用 `loop_stop` / `loop_status`）

> ⚠️ **方向（与 #4193 / #4039 一致）**：本 skill **创建 LOOP.md**，**不再调 inline-prompt `loop_start`**。Runner（#4193）从该 LOOP.md 读 prompt 启动循环并每轮重读——LOOP.md 运行时只读，无写冲突。

## 初始化步骤

### 1. 收集参数

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{task}` | Yes | — | 任务描述 / 每轮迭代的 prompt（领域细节通过 prompt 传递） |
| `{maxSteps}` | No | `10` | 最大迭代轮数 |
| `{maxDuration}` | No | `2h` | 最大总时长（`2h` / `30m` / `3600s` / `7200000` ms） |
| `{stepInterval}` | No | `30s` | 轮间隔 |
| `{senderOpenId}` | Yes | — | 发起人 open_id（加入执行群） |

从 `{task}` 生成文件系统安全的 slug（`[^A-Za-z0-9._-]+` → `-`，去首尾 `-`；slug 非空否则报错）。创建工作目录 `{DISCLAUDE_WORKSPACE_DIR}/loop-{slug}/`（用 Bash `mkdir -p`）。

### 2. 创建飞书执行群

```bash
lark-cli im +chat-create --name "Loop: {task简述}" --users "{senderOpenId}"
```

记录返回的新群 `chatId`（runner 每轮把 prompt push 到此群）。

### 3. 创建 LOOP.md（关键步骤 — 使用 Write 工具）

用 **Write 工具**写入 `{DISCLAUDE_WORKSPACE_DIR}/.disclaude/loop/{slug}/LOOP.md`（目录用 Bash 先 `mkdir -p`）。文件 = YAML frontmatter + prompt 正文，格式严格匹配 `parseLoopMd`（`packages/core/src/loop/loop-md.ts`）：

```markdown
---
name: {slug}
chatId: {新群 chatId}
workDir: {DISCLAUDE_WORKSPACE_DIR}/loop-{slug}
maxSteps: {maxSteps}
maxDuration: {maxDuration}
stepInterval: {stepInterval}
status: running
startedAt: {当前 ISO 时间，如 2026-07-11T08:30:00Z}
---

{task —— 每轮迭代的 prompt 正文}
```

**字段说明**：
- `name`：loop 标识（必填，与 slug 一致）。
- `chatId`：执行群（必填，runner 推送目标）。
- `maxSteps` / `maxDuration` / `stepInterval`：runner 参数；`maxDuration`/`stepInterval` 接受带单位字符串（`2h`/`30s`/`500ms`）或毫秒数。
- `status` / `startedAt`：信息性，可选。
- 正文（`---` 之下）= 每轮执行的 prompt，trimmed。

⚠️ 写入前用 Glob/Read 确认 `.disclaude/loop/{slug}/LOOP.md` 尚不存在（避免静默覆盖既有 loop）。

### 4. 推送首条指令到新群

向新群发送首条消息，告知 workDir 与任务，runner 随后按 LOOP.md 迭代：

```
🔧 Loop「{slug}」已启动。workDir: {workDir}。每轮将执行 LOOP.md 中的 prompt（maxSteps={maxSteps}, interval={stepInterval}）。
```

用 `mcp__channel-mcp__send_text`（chatId=新群）或 `lark-cli` 发送。

## 运行时模型（非 skill 步骤，供参考）

- Runner（`getOrCreateLoopRunner().startFromLoopMd(path)`）读 LOOP.md 启动循环，**每轮重读 prompt**（LOOP.md 运行时只读）→ 用户可中途编辑 LOOP.md 调整方向，下一轮生效。
- 停止 / 查询：用 MCP `loop_stop` / `loop_status`（按 loopId）。
- 状态/进度文件不在 LOOP.md（由用户自管，见 #4193）。

## 不做

- ❌ 不调 inline-prompt `loop_start`（已废弃；LOOP.md 是新契约）。
- ❌ 不在 LOOP.md 写状态/进度（只放 prompt + 参数）。
- ❌ 不手动每轮执行（runner 负责）。
