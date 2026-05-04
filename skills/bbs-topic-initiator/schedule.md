---
name: "BBS 话题发起"
cron: "0 9,15 * * 1-5"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# BBS 话题发起 — 定时执行

工作日每天 9:00 和 15:00 执行一次 `bbs-topic-initiator` skill，分析群组活跃度并发起话题。

## 执行

使用 `bbs-topic-initiator` skill 为群组生成话题。

参数：
- **chatId**: {controlChannelChatId}

## 安装说明

将此文件复制到 `schedules/bbs-topic-initiation/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的 BBS 群组 chatId |
