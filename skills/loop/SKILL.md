---
name: loop
description: Loop — initializes a Ralph Loop autonomous task by creating a LOOP.md definition file (prompt + YAML params) and a dedicated Feishu execution group. The LOOP.md file watcher (Issue #4283, merged) auto-starts the loop when the file is written. Use when user wants to set up a recurring/autonomous loop task. Keywords: "loop", "Ralph Loop", "循环任务", "autonomous loop", "loop 初始化".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, mcp__channel-mcp__send_text
---

# Loop — 初始化器（Ralph Loop）

为一个自主循环任务创建 **LOOP.md 定义文件** + 专用飞书执行群。文件 watcher（#4283，已合入 main）监控 `.disclaude/loop/*/LOOP.md`，在文件写入时自动调用 `getOrCreateLoopRunner().startFromLoopMd(path)` 启动循环，并将返回的 `loopId` 推送到执行群。

**适用于**: 初始化一个 loop（解析需求 → 建群 → 写 LOOP.md → 推首条指令）| **不适用于**: 每轮执行（runner 负责）、停止/查询 loop（用 `loop_stop` / `loop_status`）

> **方向（与 #4193 / #4039 / #4283 一致）**：本 skill **创建 LOOP.md**。LOOP.md 文件 watcher（#4283）是消费端——文件写入后 watcher 自动调 `startFromLoopMd`，无需手动调 `loop_start`。`loop_start`（inline-prompt）仍是活契约，本 skill 不使用（LOOP.md 是 skill 驱动的新入口，非废弃旧接口）。

## loop vs schedule：先确认用哪个

`loop`（本 skill，Ralph Loop）与 `schedule`（cron 步骤执行器）都做"周期性任务"，但机制与可纠正性差别很大。**建 loop 前先对照下表确认 loop 是你要的**——loop 一旦启动，`chatId` 不可热改、删 `LOOP.md` 也不会停（见下文「停止 / 改正 loop」），建错很难自助纠正。

| 维度 | schedule（cron） | loop（Ralph Loop，本 skill） |
| --- | --- | --- |
| 驱动方式 | cron 步骤执行器，到点跑一次 prompt | Ralph Loop，每轮 `pushToAgent` 驱动 agent 自主迭代 |
| 适合 | 固定时刻触发的独立任务（日报、提醒、定时扫描） | 需要多轮自主推进、上一轮喂下一轮的循环任务 |
| `chatId` 可热改 | ✅ 改 `SCHEDULE.md` 即生效 | ❌ 启动时只读一次，改 `LOOP.md` 的 `chatId` **不生效** |
| 删除定义文件 | 停止后续执行 | ❌ **不影响在跑的 loop**（watcher 只处理 create/change，无 remove） |
| 停止方式 | 删文件 / 设 `enabled: false` | 仅 `loop_stop(loopId)`（见下） |
| 唯一 ID | — | `loopId` 只在执行群推送一次，丢了只能翻群 |

> 选不定时：**到点触发、每轮独立 → schedule；多轮自主迭代、上一轮喂下一轮 → loop**。

## 初始化步骤

### 1. 收集参数

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{task}` | Yes | — | 任务描述 / 每轮迭代的 prompt（领域细节通过 prompt 传递） |
| `{maxSteps}` | No | `10` | 最大迭代轮数（与 `parseLoopMd` 默认一致） |
| `{maxDuration}` | No | `2h` | 最大总时长（`2h` / `30m` / `3600s` / `7200000` ms） |
| `{stepInterval}` | No | `30s` | 轮间隔 |
| `{senderOpenId}` | Yes | — | 发起人 open_id（加入执行群） |

> **Defaults 与 runner floors**：`parseLoopMd` 的默认值为 `maxSteps=10 / maxDurationMs=3600000(1h) / stepIntervalMs=30000(30s)`。runner 会 floor：`maxDuration >= 1000ms`，`stepInterval >= 100ms`，`maxSteps >= 1`。本 skill 默认 `maxSteps=10 / maxDuration=2h / stepInterval=30s`：`maxSteps`/`stepInterval` 与 `parseLoopMd` 一致；`maxDuration` 取 2h（比 parseLoopMd 的 1h 缺省更宽松）。因本 skill 总在 frontmatter 显式写入 `maxDuration`（见 Step 4），parseLoopMd 的 1h 缺省对本 skill 创建的 loop 不生效。

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

**无需手动调 `loop_start`**。LOOP.md 已写入，watcher 将自动启动循环（见 Step 5）。

### 6. 推送首条指令到新群

向新群发送首条消息，告知 workDir 与任务：

```
🔧 Loop「{slug}」已初始化。workDir: {workDir}。LOOP.md 已写入，watcher 将自动启动循环（maxSteps={maxSteps}, interval={stepInterval}）。
```

用 `mcp__channel-mcp__send_text`（chatId=新群）或 `lark-cli` 发送。

## loopId 流转

watcher 启动 loop 后返回 `loopId`（格式 `loop-{N}-{timestamp}`），推送到执行群。用户可用此 `loopId` 调 MCP `loop_stop` / `loop_status` 停止/查询循环。

## 停止 / 改正 loop（重要）

LOOP.md **不是**运行中 loop 的开关——删除或改 `chatId` 都**不能**停掉或重定向已在跑的 loop：

- **删 `LOOP.md`** → watcher 只监听 create/change（文件 `existsSync` 命中才触发），**不会** stop 已启动的 loop；loop 会继续跑到 `maxSteps` / `maxDuration` 超时。
- **改 `LOOP.md` 的 `chatId`** → runner 启动时只读一次，**改了也不生效**；正文 prompt 倒是每轮重读（可调方向，下一轮生效）。
- **唯一可靠的停止方式**：MCP `loop_stop(loopId)`。`loopId` 在 loop 启动时由 watcher 推送到执行群（**仅一次**），务必记下；丢了只能去执行群翻历史。

建错 `chatId`（例如把执行群填成了卡片目标群）时：**别只改文件**——先 `loop_stop(loopId)` 停掉错的，再用本 skill 重建一个新的 loop。

## 运行时模型（供参考）

- Runner（`getOrCreateLoopRunner().startFromLoopMd(path)`）读 LOOP.md 启动循环，**每轮重读 prompt**（LOOP.md 运行时只读）→ 用户可中途编辑 LOOP.md 调整方向，下一轮生效。
- 停止 / 查询：用 MCP `loop_stop` / `loop_status`（按 loopId）。
- 状态/进度文件不在 LOOP.md（由用户自管，见 #4193）。

## 不做

- ❌ 不调 inline-prompt `loop_start`（LOOP.md 是 skill 驱动的新入口；`loop_start` 仍是活契约，本 skill 不使用）。
- ❌ 不在 LOOP.md 写状态/进度（只放 prompt + 参数）。
- ❌ 不手动每轮执行（runner 负责）。
- ❌ 不在建群前跳过 LOOP.md 存在性检查（避免孤儿群）。
