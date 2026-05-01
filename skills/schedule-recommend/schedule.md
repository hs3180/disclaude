---
name: "智能推荐分析"
cron: "0 3 * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# 智能推荐分析 — 定时执行

每天凌晨 3 点分析用户交互记录，使用 `schedule-recommend` skill 发现重复任务模式并推荐定时任务。

## 执行

使用 `schedule-recommend` skill 分析交互模式并生成推荐报告。

参数：
- **报告发送 chatId**: {controlChannelChatId}

## 安装说明

将此文件复制到 `schedules/recommend-analysis/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的报告接收 chatId |
