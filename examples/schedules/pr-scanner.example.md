---
name: "PR 扫描器"
cron: "*/30 * * * *"
enabled: false
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
createdAt: "2026-03-01T00:00:00.000Z"
---

# PR 扫描任务

每30分钟扫描 hs3180/disclaude 仓库的 open PR，发现新 PR 时发送通知。

## 配置说明

**重要**: 使用前请将 `chatId` 替换为实际的飞书 Chat ID，并将 `enabled` 设为 `true`。

## 执行步骤

### 1. 获取当前 open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open --json number,title,author,createdAt
```

### 2. 检查已处理的 PR

读取 `workspace/data/processed-prs.json` 文件，获取已处理过的 PR 编号列表。
如果文件不存在，创建一个空列表。

### 3. 识别新 PR

对比当前 open PR 列表和已处理 PR 列表，找出新 PR。

### 4. 获取新 PR 详细信息

对于每个新 PR：
```bash
gh pr view {number} --repo hs3180/disclaude --json title,body,author,additions,deletions,changedFiles,statusCheckRollup,url
```

### 5. 发送通知

使用 `send_user_feedback` 发送格式化的 PR 信息到配置的 chatId。

通知格式：
```
## 🔔 新 PR 检测到

### PR #{number}: {title}

- **作者**: {author}
- **状态**: {CI状态}
- **变更**: +{additions} -{deletions} ({changedFiles} files)
- **链接**: {url}

---

**描述**:
{body摘要}
```

### 6. 更新已处理 PR 列表

将新处理的 PR 编号追加到 `workspace/data/processed-prs.json`。

## 注意事项

- 此任务**不会创建群聊**（ChatManager 功能待实现）
- 通知发送到配置的 chatId
- 如果没有新 PR，不发送通知
- 如果发生错误，发送错误通知到 chatId

## 错误处理

1. 如果 `gh` 命令失败，重试一次
2. 如果 `send_user_feedback` 失败，记录日志并继续
3. 如果读取/写入 processed-prs.json 失败，创建新文件

## 数据文件

`workspace/data/processed-prs.json` 格式：
```json
{
  "processedPrs": [123, 124, 125],
  "lastUpdated": "2026-03-01T00:00:00.000Z"
}
```
