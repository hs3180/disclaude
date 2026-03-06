---
name: "PR 扫描与讨论"
cron: "0 */30 * * * *"
enabled: true
blocking: true
cooldownPeriod: 300000
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-03-06T00:00:00.000Z"
---

# PR 扫描任务

每30分钟扫描仓库的 open PR，发现新 PR 时创建群聊通知。

## 执行步骤

### 1. 获取当前 open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open --json number,title,author,createdAt,headRefName,additions,deletions,changedFiles
```

### 2. 读取已处理的 PR 记录

```bash
cat workspace/data/processed-prs.json 2>/dev/null || echo "{}"
```

如果文件不存在，初始化为空对象 `{}`。

### 3. 识别新 PR

对比当前 open PR 列表与已处理记录，识别新 PR：
- 在当前列表中但不在已处理记录中的 PR
- 记录格式: `{ "pr_number": { "processedAt": "timestamp", "chatId": "oc_xxx" } }`

### 4. 处理每个新 PR

对于每个新 PR：

#### 4.1 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude --json title,body,author,state,createdAt,headRefName,baseRefName,additions,deletions,changedFiles,mergeable,mergeStateStatus,commits,files
```

#### 4.2 获取 CI 状态

```bash
gh pr checks {number} --repo hs3180/disclaude --json name,status,conclusion 2>/dev/null || echo "CI status unavailable"
```

#### 4.3 创建讨论群聊

使用 `create_group` 工具创建群聊：

```json
{
  "topic": "PR #{number}: {title}"
}
```

记录返回的 chatId。

#### 4.4 发送 PR 信息卡片

使用 `send_user_feedback` 发送包含 PR 详情的卡片消息：

```json
{
  "content": {
    "config": { "wide_screen_mode": true },
    "header": {
      "title": { "tag": "plain_text", "content": "PR #{number}: {title}" },
      "template": "blue"
    },
    "elements": [
      {
        "tag": "markdown",
        "content": "**作者**: @{author}\n**分支**: {headRefName} → {baseRefName}\n**变更**: +{additions} -{deletions} ({changedFiles} files)"
      },
      {
        "tag": "markdown",
        "content": "**CI 状态**: {ciStatus}\n**合并状态**: {mergeStateStatus}"
      },
      {
        "tag": "markdown",
        "content": "**描述**:\n{body}"
      },
      {
        "tag": "action",
        "actions": [
          {
            "tag": "button",
            "text": { "tag": "plain_text", "content": "查看 PR" },
            "url": "https://github.com/hs3180/disclaude/pull/{number}",
            "type": "primary"
          }
        ]
      }
    ]
  },
  "format": "card",
  "chatId": "{new_chat_id}"
}
```

#### 4.5 更新已处理记录

将新处理的 PR 添加到 `workspace/data/processed-prs.json`：

```json
{
  "{pr_number}": {
    "processedAt": "2026-03-06T12:00:00.000Z",
    "chatId": "oc_xxx",
    "title": "PR title"
  }
}
```

### 5. 清理过期记录（可选）

如果已处理记录超过 100 条，清理 30 天前的旧记录。

## 错误处理

1. 如果 GitHub API 调用失败，记录错误并跳过本次执行
2. 如果创建群聊失败，记录错误并继续处理下一个 PR
3. 如果发送消息失败，记录错误但仍然标记 PR 为已处理

## 注意事项

- 冷静期设置为 5 分钟，避免短时间内重复执行
- 使用 blocking 模式，确保上一次执行完成后再开始下一次
- 已处理的 PR 记录存储在 `workspace/data/processed-prs.json`

## 配置

- **扫描间隔**: 每 30 分钟
- **仓库**: hs3180/disclaude
- **通知 chatId**: oc_71e5f41a029f3a120988b7ecb76df314
- **冷静期**: 5 分钟 (300000ms)
