---
name: "Chat Timeout"
cron: "0 * * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# Chat Timeout — 每小时超时检测

每小时执行一次 chat-timeout skill，检测临时群聊的超时状态。

## 执行

使用 `chat-timeout` skill 检测映射表中的临时群聊超时状态。

参数：
- **控制频道**: {controlChannelChatId}
- **不活跃阈值**: 24 小时
- **警告等待期**: 4 小时
- **检测范围**: discussion

## 安装说明

将此文件复制到 `schedules/chat-timeout/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |
