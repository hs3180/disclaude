---
name: "BBS 话题发起"
cron: "0 9,15 * * 1-5"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# BBS 话题发起 — 定时执行

工作日每天 9:00 和 15:00 自动分析群组活跃度，在需要时发起话题。

## 执行

使用 `bbs-topic-initiator` skill 为当前群组生成一个话题。

参数：
- **目标群组**: {controlChannelChatId}
- **话题轮换**: 按星期轮换话题类型（技术前沿/经验分享/问题讨论/工具推荐/轻松闲聊）

## 安装说明

将此文件复制到 `schedules/bbs-topic-initiation/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的 BBS 群组 chatId |
