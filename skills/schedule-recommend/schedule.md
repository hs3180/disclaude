---
name: "智能推荐分析"
cron: "0 3 * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# 智能推荐分析 — 定时执行

每天凌晨 3 点分析用户交互记录，发现重复任务模式并推荐定时任务。

## 执行

使用 `schedule-recommend` skill 分析交互模式并生成定时任务推荐。

参数：
- **目标群组**: {controlChannelChatId}

要求：
1. 读取 workspace/chat/ 目录下的所有聊天记录文件
2. 分析过去 30 天的交互记录，识别重复性任务模式
3. 筛选至少出现 3 次且适合自动化的任务
4. 生成推荐报告并通过 send_user_feedback 发送到当前 chatId

注意：
- 跳过一次性任务、需要用户交互的任务、依赖上下文的任务
- 如果没有检测到可推荐的模式，不发送消息
- 推荐结果记录到 workspace/data/recommend-history.json

## 安装说明

将此文件复制到 `schedules/recommend-analysis/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |
