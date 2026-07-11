---
name: loop
description: Loop — initializes a Ralph Loop autonomous task by creating a LOOP.md definition file (prompt + YAML params) and a dedicated Feishu execution group. The LOOP.md file watcher (Issue #4283, merged) auto-starts the loop when the file is written. Use when user wants to set up a recurring/autonomous loop task. Keywords: "loop", "Ralph Loop", "循环任务", "autonomous loop", "loop 初始化".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Loop — 初始化器（Ralph Loop）

为一个自主循环任务创建 **LOOP.md 定义文件** + 专用飞书执行群。文件 watcher（#4283，已合入 main）监控 `.disclaude/loop/*/LOOP.md`，在文件写入时自动调用 `getOrCreateLoopRunner().startFromLoopMd(path)` 启动循环，并将返回的 `loopId` 推送到执行群。

**适用于**: 初始化一个 loop（解析需求 → 建群 → 写 LOOP.md → 推首条指令）| **不适用于**: 每轮执行（runner 负责）、停止/查询 loop（用 `loop_stop` / `loop_status`）

> **方向（与 #4193 / #4039 / #4283 一致）**：本 skill **创建 LOOP.md**。LOOP.md 文件 watcher（#4283）是消费端——文件写入后 watcher 自动调 `startFromLoopMd`，无需手动调 `loop_start`。`loop_start`（inline-prompt）仍是活契约，本 skill 不使用（LOOP.md 是 skill 驱动的新入口，非废弃旧接口）。

## 初始化步骤

### 1. 收集参数

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{task}` | Yes | — | 任务描述 / 每轮迭代的 prompt（领域细节通过 prompt 传递） |
| `{maxSteps}` | No | `10` | 最大迭代轮数（与 `parseLoopMd` 默认一致） |
| `{maxDuration}` | No | `2h` | 最大总时长（`2h` / `30m` / `3600s` / `7200000` ms） |
| `{stepInterval}` | No | `30s` | 轮间隔 |
| `{senderOpenId}` | Yes | — | 发起人 open_id（加入执行群） |

> **Defaults 与 runner floors**：`parseLoopMd` 的默认值为 `maxSteps=10 / maxDurationMs=3600000(1h) / stepIntervalMs=30000(30s)`。runner 会 floor：`maxDuration >= 1000ms`，`stepInterval >= 100ms`，`maxSteps >= 1`。本 skill 的默认值（2h / 30s / 10）与 `parseLoopMd` 一致。

从 `{task}` 生成文件系统安全的 slug（`[^A-Za-z0-9._-]+` → `-`，去首尾 `-`；slug 非空否则报错）。

### 2. 检查 LOOP.md 是否已存在（在建群之前）

用 Glob/Read 检查 `.disclaude/loop/{slug}/LOOP.md` 是否已存在。若已存在，提示用户该 loop 名已占用，避免创建孤儿群。

### 3. 准备工作目录 + 创建飞书执行群

创建工作目录 `{DISCLAUDE_WORKSPACE_DIR}/loop-{slug}/`（用 Bash `mkdir -p`）。

```bash
lark-cli im +chat-create --name "Loop: {task简述}" --users "{senderOpenId}"
```

记录返回的新群 `chatId`。

### 4. 创建 LOOP.md（关键步骤 — 使用 Write 工具）

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
startedAt: {当前 ISO 时间，如 2026-07-11T14:30:00Z}
---

{task —— 每轮迭代的 prompt 正文}
```

**字段说明**：
- `name`：loop 标识（必填，与 slug 一致）。
- `chatId`：执行群（必填，runner 推送目标）。
- `maxSteps` / `maxDuration` / `stepInterval`：runner 参数；`maxDuration`/`stepInterval` 接受带单位字符串（`2h`/`30s`/`500ms`）或毫秒数。
- `status` / `startedAt`：信息性，可选。
- 正文（`---` 之下）= 每轮执行的 prompt，trimmed。

### 5. LOOP.md 写入后 — watcher 自动启动

LOOP.md 写入后，**文件 watcher（#4283）自动检测到文件创建**，调用 `getOrCreateLoopRunner().startFromLoopMd(path)` 启动循环。watcher 将返回的 `loopId` 通过 `pushToAgent` 推送到执行群。

**无需手动调 `loop_start`**。LOOP.md 已写入，待 watcher 接通后自动启动。

### 6. 推送首条指令到新群

向新群发送首条消息，告知 workDir 与任务：

```
🔧 Loop「{slug}」已初始化。workDir: {workDir}。LOOP.md 已写入，watcher 将自动启动循环（maxSteps={maxSteps}, interval={stepInterval}）。
```

用 `mcp__channel-mcp__send_text`（chatId=新群）或 `lark-cli` 发送。

## loopId 流转

watcher 启动 loop 后返回 `loopId`（格式 `loop-{N}-{timestamp}`），推送到执行群。用户可用此 `loopId` 调 MCP `loop_stop` / `loop_status` 停止/查询循环。

## 运行时模型（供参考）

- Runner（`getOrCreateLoopRunner().startFromLoopMd(path)`）读 LOOP.md 启动循环，**每轮重读 prompt**（LOOP.md 运行时只读）→ 用户可中途编辑 LOOP.md 调整方向，下一轮生效。
- 停止 / 查询：用 MCP `loop_stop` / `loop_status`（按 loopId）。
- 状态/进度文件不在 LOOP.md（由用户自管，见 #4193）。

## 不做

- ❌ 不调 inline-prompt `loop_start`（LOOP.md 是 skill 驱动的新入口；`loop_start` 仍是活契约，本 skill 不使用）。
- ❌ 不在 LOOP.md 写状态/进度（只放 prompt + 参数）。
- ❌ 不手动每轮执行（runner 负责）。
- ❌ 不在建群前跳过 LOOP.md 存在性检查（避免孤儿群）。
