---
name: "智能推荐分析"
cron: "0 3 * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# 智能推荐分析 — 定时执行

每天凌晨 3:00 使用 `schedule-recommend` skill 分析用户交互记录，发现重复任务模式并推荐定时任务。

## 执行

使用 `schedule-recommend` skill 分析聊天记录，检测可自动化的任务模式。

参数：
- **目标群组**: {controlChannelChatId}

## 安装说明

将此文件复制到 `schedules/recommend-analysis/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |
