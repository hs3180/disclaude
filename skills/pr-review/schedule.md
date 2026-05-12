---
name: "PR Review"
cron: "*/30 * * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
modelTier: "low"
---

# PR Review — 定时审查

每 30 分钟执行一次 PR Review skill。

## 执行

使用 `pr-review` skill 扫描仓库 `{repo}` 的 open PR，为新 PR 创建讨论群并执行代码审查。

参数：
- **仓库**: {repo}
- **并发上限**: 3

## 审查流程

1. 读取 `workspace/bot-chat-mapping.json` 映射表
2. 获取 open PR 列表
3. 过滤已有群的 PR，检测状态变更
4. 为新 PR 创建讨论群（`lark-cli im chat create`）
5. 获取 PR diff 并执行代码审查
6. 将审查结果发送到对应讨论群（`send_card`）
7. 向控制频道发送审查完成通知

## 安装说明

将此文件复制到 `schedules/pr-review/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |
| `{repo}` | 实际监控的 GitHub 仓库（如 `owner/repo`） |
