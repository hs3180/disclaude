---
name: "Chat Timeout 检测"
cron: "*/15 * * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# Chat Timeout — 定时检测

每 15 分钟执行一次 Chat Timeout skill，检测并清理过期临时会话。

## 执行

使用 `chat-timeout` skill 检测过期临时会话并解散群组。

参数：
- **控制频道**: {controlChannelChatId}
- **保留天数**: 7

## 安装说明

将此文件复制到 `schedules/chat-timeout/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId（用于接收执行报告） |
