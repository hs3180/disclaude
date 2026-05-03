---
name: "BBS 话题发起"
cron: "0 9,15 * * 1-5"
enabled: false
blocking: true
chatId: "{controlChannelChatId}"
---

# BBS 话题发起 — 定时执行

工作日每天 9:00 和 15:00 自动分析群组活跃度，在需要时发起话题。

## 执行

使用 `bbs-topic-initiator` skill 为当前群组生成话题。

参数：
- **chatId**: {chatId}

### 活跃度判断

- 如果最近 4 小时内有超过 5 条消息，跳过本次（群组已活跃）
- 如果最近 4 小时内已发送过话题，跳过本次（避免重复）

### 话题类型轮换

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

安装后将 `enabled` 设为 `true` 即可启用。
