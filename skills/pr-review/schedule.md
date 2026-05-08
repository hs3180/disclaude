---
name: "PR Review"
cron: "15,45 * * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# PR Review — 定时代码审查

每小时的第 15 和 45 分钟执行 PR Review skill，与 pr-scanner（每半小时整点执行）错开 15 分钟。

## 执行

使用 `pr-review` skill 审查仓库 `{repo}` 中已创建讨论群的 PR。

参数：
- **仓库**: {repo}
- **并发上限**: 3

## 时序配合

| 时间 | 任务 |
|------|------|
| :00, :30 | PR Scanner — 扫描新 PR、创建讨论群 |
| :15, :45 | PR Review — 审查已建群的 PR、发送 review 卡片 |

## 安装说明

将此文件复制到 `schedules/pr-review/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |
| `{repo}` | 实际监控的 GitHub 仓库（如 `owner/repo`） |
