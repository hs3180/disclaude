# Loop Schedule Template

> **通用 Schedule 驱动 Agent 循环执行模板**
> 不绑定特定场景（research/monitoring/任何 loop 任务均可复用）。

## 核心机制

```
Schedule tick → Agent 读取状态文件 → 确定下一步 → 执行一步 → 更新状态 → 结束本次 tick
```

每个 tick 只做一件事。Agent 自主判断当前阶段和下一步操作，完成后将控制权交还给 scheduler。

---

## 状态文件约定

每个 loop 任务维护一个 `STATE.md` 文件（位于任务工作目录根），使用 frontmatter 记录执行状态：

```yaml
---
status: planning | executing | completed | error
phase: string          # 当前阶段名称（由场景定义）
createdAt: ISO_timestamp
updatedAt: ISO_timestamp
---
```

### 状态字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | enum | `planning`（规划中）、`executing`（执行中）、`completed`（已完成）、`error`（出错） |
| `phase` | string | 场景定义的阶段标识，Agent 据此判断下一步操作 |
| `createdAt` | ISO 8601 | 任务创建时间 |
| `updatedAt` | ISO 8601 | 最后一次 tick 更新时间 |

frontmatter 之后的正文是 Agent 维护的自由格式内容（任务描述、待办、笔记等）。

---

## Tick 执行流程

每个 schedule tick 触发时，Agent 执行以下流程：

### 1. 读取状态

```bash
cat {WORK_DIR}/STATE.md
```

> `{WORK_DIR}` 由初始化 Skill（Part 2）创建时确定，默认为 `$DISCLAUDE_WORKSPACE_DIR/schedules/<slug>/`。

解析 frontmatter 获取 `status`、`phase`。

### 2. 判断是否完成

- 若 `status == completed`：**禁用 schedule**（设置 `enabled: false`），输出完成摘要，结束本次 tick。
- 若 `status == error`：输出错误信息，尝试恢复或禁用 schedule，结束本次 tick。

### 3. 执行一步

根据 `phase` 和正文中的待办列表，执行**一个**步骤：
- 一个 tick 只做一件事
- 步骤应该是原子的、可独立验证的
- 步骤粒度：5-15 分钟内可完成

### 4. 更新状态

执行完成后，更新 `STATE.md`：
- `updatedAt` 更新为当前时间
- `phase` 根据进展推进（如已完成当前阶段的所有步骤）
- `status` 在所有阶段完成时设为 `completed`
- 正文中更新待办列表（标记已完成项）

### 5. 推送进度（可选）

在关键节点通过 `send_user_feedback` 推送进度通知到群聊：
- 阶段切换时
- 重要发现或结果时
- 错误发生时

### 6. 结束本次 tick

输出简短的状态摘要，结束执行。等待下一个 schedule tick。

---

## 完成条件

当 Agent 判定任务完成时：
1. 将 `status` 设为 `completed`
2. 在正文中写入最终摘要
3. **禁用 schedule**：修改 SCHEDULE.md 的 `enabled: false`
4. 发送完成通知到群聊

下一个 tick 会检测到 `status == completed` 并确认 schedule 已禁用。

---

## 错误处理

- **步骤失败不阻塞**：记录错误到 `STATE.md`，`status` 可设为 `error`，但 schedule 不自动禁用
- **下一个 tick 会重新读取状态**：Agent 可尝试恢复或跳过
- **连续失败保护**：如果连续多次 error 仍未恢复，Agent 应主动禁用 schedule 并通知用户
- **不要 panic**：错误信息写入状态文件，保持冷静继续

---

## 与其他组件的关系

| 组件 | 职责 |
|------|------|
| **Loop Schedule 模板**（本文件） | 定义通用 tick 执行范式和状态约定 |
| **Loop Schedule 初始化 Skill**（Part 2） | 接收用户需求，创建工作目录、STATE.md、群聊、注册 schedule |
| **Loop Chat System Prompt**（Part 3） | 注入到群聊的 system prompt，赋予 Agent 场景感知和具体阶段定义 |

### 使用方式

1. 初始化 Skill 创建工作目录和初始 `STATE.md`
2. 初始化 Skill 注册 schedule task，schedule prompt 引用本模板的执行范式
3. 初始化 Skill 通过 `push_to_agent` 注入 System Prompt（包含场景特化内容）
4. 每个 tick 触发时，Agent 按「Tick 执行流程」执行

---

## 设计原则

- **纯模板，无运行时代码**：本文件是 markdown 文档，指导 Agent 行为
- **通用**：不绑定特定场景，任何需要循环执行的任务都能用
- **简洁**：一个 tick 做一件事
- **可组合**：初始化 Skill 负责实例化，System Prompt 负责场景特化
- **幂等**：每个 tick 的结果写入 STATE.md，中断后可从上次状态恢复
