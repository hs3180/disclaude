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
- **并发上限**: {maxConcurrent}（默认 3）
- **邀请用户**: {inviteUsers}（可选，逗号分隔的飞书 open_id，创建讨论群时自动邀请）

### 限流策略

在调用 `pr-scanner` skill 之前，先检查映射表中 `purpose: 'pr-review'` 的条目数：
- 若 ≥ `{maxConcurrent}` → 跳过本次扫描，记录日志
- 否则 → 正常执行，skill 会为所有新 PR 创建讨论群

## 安装说明

将此文件复制到 `schedules/pr-scanner/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |
| `{repo}` | 实际监控的 GitHub 仓库（如 `owner/repo`） |
| `{maxConcurrent}` | 并发上限（默认 `3`） |
| `{inviteUsers}` | 逗号分隔的飞书 open_id（如 `ou_xxx,ou_yyy`），留空则不邀请额外用户 |
