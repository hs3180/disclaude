---
name: "Task Progress Reporter"
cron: "*/60 * * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# Task Progress Reporter

定期扫描运行中的任务，智能判断是否需要向用户汇报进度。

## 背景

当用户提交复杂任务后，可能需要多轮迭代才能完成。在任务执行期间，用户无法了解进展。

此 schedule 通过调用 `task-progress` skill 实现：
- 不是固定间隔汇报（已拒绝的 PR #1262 方案）
- 由 Agent 自行判断是否有值得汇报的进展
- 仅在有新信息时才发送进度更新

## 配置

- **扫描间隔**: 每 60 秒
- **任务目录**: `workspace/tasks/`
- **通知目标**: 配置的 chatId

## 工作原理

1. 扫描 `workspace/tasks/` 中存在 `running.lock` 的目录（运行中的任务）
2. 读取每个任务的状态文件（task.md, iterations/, last_progress.md）
3. 与上次汇报的状态对比，判断是否有新进展
4. 如果有新进展，通过 `send_user_feedback` 发送进度卡片
5. 更新 `last_progress.md` 记录本次汇报内容

## 智能判断逻辑

Agent 会根据以下条件决定是否汇报：

| 场景 | 是否汇报 | 原因 |
|------|----------|------|
| 新迭代完成 | ✅ 汇报 | 有实质性进展 |
| 任务完成/失败 | ✅ 汇报 | 状态变更，用户需要知道 |
| 评估结果变化 | ✅ 汇报 | 方向可能有调整 |
| 仅 running.lock 更新 | ❌ 不汇报 | 无新信息 |
| 上次汇报 < 2分钟 | ❌ 不汇报 | 避免频繁打扰 |

## 使用说明

1. 复制此文件到 `workspace/schedules/task-progress.md`
2. 将 `chatId` 替换为实际的飞书群聊 ID
3. 设置 `enabled: true`
4. 确保已创建任务（通过 `/deep-task` skill）
5. 当任务开始执行后，进度汇报将自动运行

## 注意事项

- 此 schedule 仅负责汇报进度，不执行任务
- 任务执行由 Deep Task Scanner schedule 负责
- 两个 schedule 应配置相同的 chatId
- 如果没有运行中的任务，此 schedule 会静默退出
