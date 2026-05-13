---
name: "Task Progress Reporter"
cron: "*/60 * * * * *"
enabled: false
blocking: false
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# Task Progress Reporter

定期扫描 `tasks/` 目录，发现正在执行或等待中的任务，向用户发送进度报告卡片。

## 配置

- **扫描间隔**: 每 60 秒
- **任务目录**: `workspace/tasks/`
- **通知目标**: 从 task.md 中提取的 Chat ID（schedule 配置的 chatId 作为兜底）
- **阻塞模式**: `false`（非阻塞，不占用任务执行资源）

## 使用说明

1. 复制此文件到 `workspace/schedules/task-progress.md`
2. 将 `chatId` 替换为实际的飞书群聊 ID（作为兜底通知目标）
3. 设置 `enabled: true`
4. 调度器将自动扫描任务并发送进度报告

## 与 Deep Task Scanner 的关系

此 Schedule 与 Deep Task Scanner 配合使用：

| Schedule | 职责 | 间隔 |
|----------|------|------|
| Deep Task Scanner | 扫描并**执行**任务 | 30 秒 |
| Task Progress Reporter | 扫描并**报告**任务进度 | 60 秒 |

## 报告策略

| 任务状态 | 报告行为 |
|---------|---------|
| **pending** | 发送等待中卡片 |
| **running** | 发送执行中卡片（含最新迭代摘要） |
| **completed** | 发送完成卡片（仅首次检测到时） |
| **failed** | 发送失败卡片（仅首次检测到时） |
