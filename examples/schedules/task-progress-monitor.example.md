---
name: "Task Progress Monitor"
cron: "*/2 * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# Task Progress Monitor

独立汇报 Agent，定期检查任务状态并智能决定是否向用户汇报进度。

## 背景

Issue #857: 复杂任务执行时用户长时间收不到反馈。本调度任务使用独立 Agent 方案（非固定规则），通过 `get_task_status` MCP Tool 读取任务状态，由 Agent 自行判断汇报时机和内容。

## 配置

- **检查间隔**: 每 2 分钟
- **通知目标**: 配置的 chatId
- **依赖 MCP Tool**: `get_task_status`

## 工作原理

### 与 deep-task 的关系

```
deep-task (每 30 秒)          task-progress-monitor (每 2 分钟)
     │                              │
     ├─ 扫描 tasks/ 目录            ├─ 调用 get_task_status
     ├─ 执行待处理任务              ├─ 分析任务状态变化
     ├─ 写入迭代记录                ├─ 智能决定是否汇报
     └─ 更新状态文件                └─ 发送进度卡片
```

deep-task 负责任务执行，task-progress-monitor 负责用户沟通。

### 智能汇报策略

Agent 不会固定间隔汇报，而是根据以下情况判断：

| 情况 | 操作 |
|------|------|
| 任务刚启动 (pending → running) | ✅ 汇报：确认任务已开始 |
| 任务完成 | ✅ 汇报：通知用户 |
| 任务失败 | ✅ 汇报：提醒用户可能需要介入 |
| 任务运行 > 10 分钟无迭代变化 | ✅ 汇报：可能卡住 |
| 任务运行 > 30 分钟 | ✅ 汇报：长时间运行更新 |
| 迭代次数显著增加 | ✅ 汇报：重要进展 |
| 运行中，无变化，< 10 分钟 | ❌ 不汇报：无有意义变化 |

## 使用说明

1. 确保 deep-task 调度已配置并启用
2. 将此文件复制到 `workspace/schedules/task-progress-monitor.md`
3. 将 `chatId` 替换为实际的飞书群聊 ID
4. 设置 `enabled: true`
5. 确保 MCP Tool `get_task_status` 可用

## 注意事项

- 本调度仅做监控和汇报，不执行任何任务
- 间隔建议 2 分钟（避免过于频繁，也避免信息滞后）
- 如果没有活跃任务，Agent 不会发送任何消息
