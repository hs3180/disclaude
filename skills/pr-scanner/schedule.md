---
name: "PR Scanner"
cron: "*/30 * * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# PR Scanner — 定时扫描

每 30 分钟执行一次 PR Scanner skill。

## 执行

使用 `pr-scanner` skill 扫描仓库 `{repo}` 的 open PR。

参数：
- **仓库**: {repo}
- **并发上限**: 3

## 安装说明

将此文件复制到 `schedules/pr-scanner/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |
| `{repo}` | 实际监控的 GitHub 仓库（如 `owner/repo`） |
