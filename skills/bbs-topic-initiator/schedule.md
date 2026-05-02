---
name: "BBS 话题发起"
cron: "0 9,15 * * 1-5"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# BBS 话题自动发起 — 定时执行

工作日每天 9:00 和 15:00 自动分析群组活跃度，在需要时发起话题。

## 执行

使用 `bbs-topic-initiator` skill 为当前群组生成一个话题。

参数：
- **目标群组 chatId**: {controlChannelChatId}

## 执行步骤

### 1. 检查最近活跃度

读取当前群组的聊天记录：

```bash
cat workspace/chat/{chatId}.md 2>/dev/null | tail -100 || echo "No chat history"
```

**活跃度判断标准**：
- 如果最近 4 小时内有超过 5 条消息，跳过本次（群组已活跃）
- 如果最近 4 小时内已发送过话题，跳过本次（避免重复）

### 2. 生成话题

使用 `bbs-topic-initiator` skill 根据分析结果选择话题类型：

| 星期 | 话题类型 |
|------|----------|
| 周一 | 技术前沿 / 本周计划 |
| 周二 | 经验分享 / 最佳实践 |
| 周三 | 问题讨论 / 技术挑战 |
| 周四 | 工具推荐 / 效率提升 |
| 周五 | 轻松闲聊 / 本周总结 |

### 3. 发送话题

使用 `send_user_feedback` 发送到当前 chatId：

```
send_user_feedback({
  chatId: "{chatId}",
  message: "{generated_topic}"
})
```

## 错误处理

1. 如果聊天记录读取失败，生成一个通用话题
2. 如果 `send_user_feedback` 失败，记录日志
3. 如果群组已活跃或刚发过话题，静默跳过

## 安装说明

将此文件复制到 `schedules/bbs-topic-initiation/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的 BBS 群组 chatId |
