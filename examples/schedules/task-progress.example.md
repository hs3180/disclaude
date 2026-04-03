---
name: "Task Progress Reporter"
cron: "0 * * * * *"
enabled: false
blocking: false
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# Task Progress Reporter

定期扫描任务进度，向用户发送进度更新卡片。

## 背景

Issue #857: 独立汇报 Agent 方案。通过定时扫描任务状态，智能判断是否需要向用户汇报进度。

替代原有的固定间隔 ProgressReporter，使用 Agent 自主判断汇报时机和内容。

## 配置

- **扫描间隔**: 每分钟（与 Deep Task Scanner 配合使用）
- **通知目标**: 配置的 chatId
- **阻塞模式**: false（不阻塞其他定时任务）

## 工作流程

### 1. 扫描所有任务

使用 `list_tasks` 获取所有任务状态：

```
list_tasks({})
```

### 2. 识别需要汇报的任务

对每个任务判断是否需要汇报：

| 状态 | 是否汇报 | 原因 |
|------|---------|------|
| running + 有新进度 | ✅ 是 | 用户需要知道进展 |
| running + 无新进度 | ❌ 否 | 避免重复通知 |
| completed | ✅ 是 | 通知用户任务完成 |
| failed | ✅ 是 | 通知用户任务失败 |
| pending | ❌ 否 | 等待 Deep Task Scanner 处理 |

### 3. 获取详细状态

对需要汇报的任务，使用 `get_task_status` 获取详细信息：

```
get_task_status({taskId: "task_id_here"})
```

### 4. 发送进度卡片

根据任务状态发送不同样式的卡片：

#### 运行中任务（蓝色卡片）

```json
{
  "card": {
    "config": {"wide_screen_mode": true},
    "header": {
      "title": {"tag": "plain_text", "content": "🔄 任务执行中"},
      "template": "blue"
    },
    "elements": [
      {"tag": "markdown", "content": "**任务**: {title}"},
      {"tag": "markdown", "content": "**迭代**: {iterations} / {maxIterations}"},
      {"tag": "markdown", "content": "**进度**: {progressSummary}"},
      {"tag": "hr"},
      {"tag": "markdown", "content": "_最后更新: {lastProgressUpdate}_"}
    ]
  },
  "chatId": "oc_xxx"
}
```

#### 已完成任务（绿色卡片）

```json
{
  "card": {
    "config": {"wide_screen_mode": true},
    "header": {
      "title": {"tag": "plain_text", "content": "✅ 任务完成"},
      "template": "green"
    },
    "elements": [
      {"tag": "markdown", "content": "**任务**: {title}"},
      {"tag": "markdown", "content": "**总迭代**: {iterations}"},
      {"tag": "hr"},
      {"tag": "markdown", "content": "_完成时间: {lastProgressUpdate}_"}
    ]
  },
  "chatId": "oc_xxx"
}
```

#### 失败任务（红色卡片）

```json
{
  "card": {
    "config": {"wide_screen_mode": true},
    "header": {
      "title": {"tag": "plain_text", "content": "❌ 任务失败"},
      "template": "red"
    },
    "elements": [
      {"tag": "markdown", "content": "**任务**: {title}"},
      {"tag": "markdown", "content": "**迭代**: {iterations} / {maxIterations}"},
      {"tag": "markdown", "content": "**错误**: {errorMessage}"}
    ]
  },
  "chatId": "oc_xxx"
}
```

## 智能汇报策略

与固定间隔的 ProgressReporter 不同，此 Agent 自主判断：

1. **避免重复**: 检查 `lastProgressUpdate` 时间，如果进度未变化则跳过
2. **聚焦变化**: 只汇报自上次报告以来的新进展
3. **分级通知**: 失败 > 完成 > 进度更新
4. **合并汇报**: 多个任务状态变化时，合并为一条消息

## 与 Deep Task Scanner 的配合

| 组件 | 职责 | 间隔 |
|------|------|------|
| Deep Task Scanner | 扫描并执行任务 | 每 30 秒 |
| Task Progress Reporter | 监控并汇报进度 | 每 60 秒 |

两个定时任务通过文件系统（`running.lock`、`progress.md`）进行协调，无需直接通信。

## 使用说明

1. 复制此文件到 `workspace/schedules/task-progress.md`
2. 将 `chatId` 替换为实际的飞书群聊 ID
3. 设置 `enabled: true`
4. 确保 Deep Task Scanner 已启用（用于执行任务）
5. Reporter 将自动监控任务进度并发送更新

## 架构说明

```
┌─────────────────┐     ┌──────────────────┐
│   Deep Task     │────▶│  Task Context    │
│   (主任务)       │     │  (progress.md)   │
└─────────────────┘     └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  Reporter Agent  │
                        │  (本定时任务)      │
                        └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │   用户通知        │
                        │  (send_card)     │
                        └──────────────────┘
```

## 相关

- Issue #857: 复杂任务自动启动 Task Agent 并提供进度报告
- Deep Task Scanner: 负责任务执行
- task-progress skill: Reporter Agent 的技能定义
