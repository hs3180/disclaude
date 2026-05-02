---
name: "智能推荐分析"
cron: "0 3 * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# 智能定时任务推荐分析 — 定时执行

每天凌晨 3 点分析用户交互记录，发现重复任务模式并推荐定时任务。

## 执行

使用 `schedule-recommend` skill 分析当前 chatId 的交互记录并生成推荐。

参数：
- **目标 chatId**: {controlChannelChatId}

## 执行步骤

### 1. 获取所有聊天记录文件

```bash
ls workspace/chat/*.md 2>/dev/null || echo "No chat files found"
```

如果 `workspace/chat/` 目录不存在或为空，跳过本次执行。

### 2. 分析每个聊天的交互记录

对于每个聊天记录文件，使用 `schedule-recommend` skill 分析过去 30 天的交互记录，识别：

- **重复性任务**: 用户多次请求的相同或相似任务
- **时间模式**: 任务通常在什么时间被请求
- **任务特征**: 任务是否适合自动化（自包含、有明确成功标准、可独立运行）

筛选条件：
- 至少出现 3 次的相似请求
- 请求发生在相似的时间段
- 任务适合定时执行（信息检索、报告生成、监控等）

### 3. 发送推荐消息

使用 `send_user_feedback` 将推荐消息发送到配置的 chatId。

如果没有任何可推荐的模式，不发送消息。

### 4. 记录分析结果

将分析结果追加到 `workspace/data/recommend-history.json`。

## 不推荐的情况

跳过以下类型的任务：
- 一次性任务
- 需要用户交互的任务
- 依赖上下文的任务
- 需要实时决策的任务

## 错误处理

1. 如果聊天记录文件读取失败，跳过该文件继续处理其他文件
2. 如果 `send_user_feedback` 失败，记录日志并重试一次
3. 如果没有任何可推荐的模式，不发送消息

## 安装说明

将此文件复制到 `schedules/recommend-analysis/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的 chatId |
