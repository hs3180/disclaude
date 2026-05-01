---
name: "BBS 话题发起"
cron: "0 9,15 * * 1-5"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# BBS 话题发起 — 定时执行

工作日每天 9:00 和 15:00 自动分析群组活跃度，在需要时使用 `bbs-topic-initiator` skill 发起话题。

## 执行

使用 `bbs-topic-initiator` skill 生成并发送话题到指定群组。

参数：
- **群组 chatId**: {controlChannelChatId}

话题类型按星期轮换：

| 星期 | 话题类型 |
|------|----------|
| 周一 | 技术前沿 / 本周计划 |
| 周二 | 经验分享 / 最佳实践 |
| 周三 | 问题讨论 / 技术挑战 |
| 周四 | 工具推荐 / 效率提升 |
| 周五 | 轻松闲聊 / 本周总结 |

## 安装说明

将此文件复制到 `schedules/bbs-topic-initiation/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的 BBS 群组 chatId |
