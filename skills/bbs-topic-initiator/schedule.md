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

使用 `bbs-topic-initiator` skill 为当前群组生成话题。

参数：
- **目标群组**: {controlChannelChatId}

要求：
1. 读取 workspace/chat/{chatId}.md 分析最近的讨论
2. 根据上下文选择合适的话题类型（技术前沿 / 经验分享 / 轻松闲聊）
3. 生成一个开放式的、引人参与的话题
4. 使用 send_user_feedback 发送到当前 chatId

注意：
- 如果最近 4 小时内已有活跃讨论，跳过本次
- 避免重复相似的话题
- 按星期轮换话题类型（周一: 技术前沿, 周二: 经验分享, 周三: 问题讨论, 周四: 工具推荐, 周五: 轻松闲聊）

## 安装说明

将此文件复制到 `schedules/bbs-topic-initiation/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的 BBS 群组 chatId |
