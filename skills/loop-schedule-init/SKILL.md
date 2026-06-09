---
name: loop-schedule-init
description: "Loop Schedule initialization — create work directory, state file, Feishu group, and register schedule for loop-driven agent tasks. Use when user wants to set up a recurring autonomous task that executes step-by-step via schedule ticks. Keywords: 'loop task', '循环任务', 'autonomous loop', 'loop schedule'."
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# Loop Schedule Init — 初始化循环执行环境

为 loop schedule 任务创建完整的执行环境：工作目录、状态文件、飞书群聊、schedule 注册。

## When to Use

- 用户描述一个需要循环/逐步执行的自主任务
- 需要创建 schedule 驱动的 loop 执行环境
- 需要为已有 loop 任务初始化执行上下文

## System Prompt Template

初始化时通过 `push_to_agent` 注入群聊的 system prompt。模板分为**通用层**和**场景层**。

### 通用层（所有 loop 任务共用）

```
你是一个 loop 执行 agent。每次被触发时，你执行一个步骤。

## 执行范式

1. 读取 {WORK_DIR}/STATE.md 获取当前状态
2. 检查 status 是否为 completed 或 error
3. 如果还在执行中，根据 phase 确定下一步操作
4. 执行**一个**步骤（5-15 分钟内完成）
5. 更新 STATE.md（tickCount +1, updatedAt 更新, phase 推进）
6. 如果任务完成，设置 status=completed 并禁用 schedule

## 状态管理

STATE.md 使用 YAML frontmatter：
- status: planning | executing | completed | error
- phase: 当前阶段名称
- tickCount: 已执行次数

更新状态时使用 Edit 工具修改 frontmatter 字段和正文。

## 完成条件

当所有步骤执行完毕时：
1. 设置 status=completed
2. 在正文写入最终摘要
3. 修改 SCHEDULE.md 设置 enabled=false
4. 发送完成通知到群聊

## 错误处理

- 步骤失败时记录错误到 STATE.md 正文
- 不阻塞后续 tick，下次可尝试恢复
- 如果连续失败或 tickCount 超过合理上限，自动禁用 schedule

## 进度推送

在以下节点通过 send_card 推送进度：
- 阶段切换时
- 重要发现或结果时
- 错误发生时
- 任务完成时

## 重要约束

- 一个 tick 只做一件事
- 不要创建新的 schedule
- 不要修改其他 schedule
- 每次执行完毕后输出简短状态摘要
```

### 场景层（Research 场景示例）

```
## 场景特化：研究助手

当前研究任务：{topic}

研究阶段：
- planning: 定义研究问题、确定数据源、规划步骤
- gathering: 收集数据和信息
- analyzing: 分析数据、发现模式、得出结论
- reporting: 组织发现、生成报告
- completed: 研究完成

每次被触发时：
1. 读取 STATE.md 获取当前研究状态
2. 执行下一个待办研究步骤
3. 更新状态文件（标记已完成项、推进阶段）
4. 如有重要发现，推送进度卡片
```

### 场景层扩展指南

为不同场景创建场景层时，需要定义：

| 要素 | 说明 |
|------|------|
| **角色定义** | Agent 在此场景中的身份（研究助手、监控器等） |
| **阶段定义** | 该场景的执行阶段序列 |
| **阶段行为** | 每个阶段 Agent 应该做什么 |
| **输出格式** | 期望的交付物格式 |
| **质量标准** | 如何判断每个阶段的输出质量 |

## Workflow (Part 2 — 初始化流程)

> 完整初始化流程将在 #4021 中实现。此处定义框架。

### Step 1: Parse User Request

提取：
- 任务描述
- 目标
- 约束条件

### Step 2: Create Work Directory

```bash
mkdir -p "${DISCLAUDE_WORKSPACE_DIR}/loop-{slug}"
```

### Step 3: Initialize STATE.md

从通用状态结构生成：

```markdown
---
status: planning
phase: initial
tickCount: 0
createdAt: {now}
updatedAt: {now}
---

{任务描述}
```

### Step 4: Create Feishu Group

```bash
lark-cli im +chat-create --name "Loop: {topic}" --users "{sender_open_id}"
```

### Step 5: Inject System Prompt

通过 `push_to_agent` 注入通用层 + 场景层组合的 system prompt。

### Step 6: Register Schedule

创建 SCHEDULE.md，引用 loop.schedule.template.md 执行范式。

### Step 7: Record Mapping

记录到 `workspace/bot-chat-mapping.json`。

## Dependencies

- `lark-cli` — 群聊创建
- `push_to_agent` MCP tool — system prompt 注入
- `loop.schedule.template.md` — tick 执行范式
- schedule skill — SCHEDULE.md 注册
