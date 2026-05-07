---
name: "PR Review"
cron: "*/30 * * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# PR Review — 定时审查

每 30 分钟执行一次 PR Review skill。

## 执行

使用 `pr-review` skill 扫描仓库 `{repo}` 的 open PR，为新 PR 创建审查群、分析 diff 并发送 Review 卡片，为已关闭/合并的 PR 发送状态变更通知。

参数：
- **仓库**: {repo}
- **并发上限**: 3

## 安装说明

将此文件复制到 `workspace/schedules/pr-review/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |
| `{repo}` | 实际监控的 GitHub 仓库（如 `owner/repo`） |
