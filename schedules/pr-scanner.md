---
name: "PR Scanner (Serial)"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner - 临时会话管理

定期扫描仓库的 open PR，使用基于文件系统的临时会话方案（Issue #1317）追踪 PR 审核状态。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **会话超时**: 60 分钟
- **会话目录**: `workspace/temporary-sessions/`

## 会话文件格式

每个 PR 对应一个 JSON 文件 `workspace/temporary-sessions/pr-{number}.json`：

```json
{
  "status": "pending",
  "prNumber": 123,
  "chatId": "oc_71e5f41a029f3a120988b7ecb76df314",
  "messageId": null,
  "createdAt": "2026-03-10T10:00:00Z",
  "expiresAt": "2026-03-10T11:00:00Z",
  "context": {
    "title": "Fix bug",
    "author": "username",
    "headRef": "feature/branch",
    "baseRef": "main",
    "mergeable": true,
    "ciStatus": "passing",
    "additions": 100,
    "deletions": 50,
    "changedFiles": 5,
    "description": "Brief description..."
  },
  "response": null
}
```

## 状态定义

| 状态 | 含义 | 触发条件 |
|------|------|----------|
| `pending` | 等待用户响应 | 创建会话文件后 |
| `active` | 用户已响应 | 检测到用户点击了按钮 |
| `expired` | 会话超时 | 超过 `expiresAt` 时间 |

## 执行步骤

### 1. 初始化会话目录

```bash
mkdir -p workspace/temporary-sessions/
```

### 2. 清理过期会话

检查 `workspace/temporary-sessions/` 中所有 `pr-*.json` 文件，将超过 `expiresAt` 的会话状态更新为 `expired` 并删除文件：

```bash
now=$(date -u +%s)
for f in workspace/temporary-sessions/pr-*.json; do
  [ -f "$f" ] || continue
  expires=$(jq -r '.expiresAt' "$f" 2>/dev/null)
  if [ -n "$expires" ] && [ "$expires" != "null" ]; then
    exp_epoch=$(date -d "$expires" +%s 2>/dev/null)
    if [ -n "$exp_epoch" ] && [ "$exp_epoch" -lt "$now" ]; then
      rm "$f"
    fi
  fi
done
```

### 3. 检查是否有活跃会话

```bash
ls workspace/temporary-sessions/pr-*.json 2>/dev/null
```

如果存在任何会话文件，说明有 PR 正在等待用户反馈，**退出本次执行**（串行处理原则）。

### 4. 获取 open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open \
  --json number,title,author,labels,mergeable,statusCheckRollup,updatedAt
```

### 5. 过滤已处理的 PR

排除以下 PR：
- 已被 review/approve 的 PR（有 `approved`, `changes_requested` 状态的 review）
- 由 bot 创建的 PR（如 issue-solver 自动提交的）

### 6. 选择第一个未处理的 PR

取过滤后的第一个 PR 作为处理对象。如果没有未处理的 PR，**退出本次执行**。

### 7. 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

### 8. 创建会话文件

使用 Write 工具创建 `workspace/temporary-sessions/pr-{number}.json`，将步骤 7 获取的 PR 信息填入 JSON：

- `status`: `"pending"`
- `prNumber`: PR 编号
- `chatId`: schedule 的 chatId（即 `oc_71e5f41a029f3a120988b7ecb76df314`）
- `messageId`: `null`
- `createdAt`: 当前 UTC 时间（ISO 8601）
- `expiresAt`: 当前时间 + 60 分钟（ISO 8601）
- `context`: PR 详细信息
- `response`: `null`

### 9. 发送 PR 摘要卡片

使用 `send_card` 发送 PR 信息摘要到 schedule 的 chatId（format: "card"）：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "🔔 新 PR 待审核", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "**PR #{number}**: {title}\n\n| 属性 | 值 |\n|------|------|\n| 👤 作者 | {author} |\n| 🌿 分支 | `{headRef}` → `{baseRef}` |\n| 📊 合并状态 | {mergeable} |\n| 🔍 CI 检查 | {ciStatus} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |\n\n📋 {description 前200字符}\n\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})"},
    {"tag": "hr"},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "⏰ 会话将在 60 分钟后自动过期"}
    ]}
  ]
}
```

### 10. 发送交互式操作卡片

使用 `send_interactive` 发送操作选项卡片到 schedule 的 chatId（format: "card"）：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "🎯 请选择处理方式", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ 合并", "tag": "plain_text"}, "value": "merge", "type": "primary"},
      {"tag": "button", "text": {"content": "🔄 请求修改", "tag": "plain_text"}, "value": "request_changes", "type": "default"},
      {"tag": "button", "text": {"content": "❌ 关闭", "tag": "plain_text"}, "value": "close", "type": "danger"},
      {"tag": "button", "text": {"content": "⏳ 稍后处理", "tag": "plain_text"}, "value": "later", "type": "default"}
    ]}
  ]
}
```

**actionPrompts**（将 `{number}` 替换为实际 PR 编号）：

```json
{
  "merge": "[用户操作] 用户批准合并 PR #{number}。请执行以下步骤：\n1. 读取 workspace/temporary-sessions/pr-{number}.json 确认会话存在\n2. 使用 jq 更新状态：`jq '.status = \"active\" | .response = \"merge\"' workspace/temporary-sessions/pr-{number}.json > /tmp/pr-session.tmp && mv /tmp/pr-session.tmp workspace/temporary-sessions/pr-{number}.json`\n3. 检查 CI 状态：`gh pr checks {number} --repo hs3180/disclaude`\n4. 如果 CI 通过，执行合并：`gh pr merge {number} --repo hs3180/disclaude --merge --delete-branch`\n5. 删除会话文件：`rm workspace/temporary-sessions/pr-{number}.json`\n6. 报告执行结果",
  "request_changes": "[用户操作] 用户请求修改 PR #{number}。请执行以下步骤：\n1. 读取 workspace/temporary-sessions/pr-{number}.json 确认会话存在\n2. 使用 jq 更新状态：`jq '.status = \"active\" | .response = \"request_changes\"' workspace/temporary-sessions/pr-{number}.json > /tmp/pr-session.tmp && mv /tmp/pr-session.tmp workspace/temporary-sessions/pr-{number}.json`\n3. 询问用户需要修改的具体内容\n4. 使用 gh pr comment 添加评论：`gh pr comment {number} --repo hs3180/disclaude --body '{comment}'`\n5. 删除会话文件：`rm workspace/temporary-sessions/pr-{number}.json`\n6. 报告执行结果",
  "close": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. 读取 workspace/temporary-sessions/pr-{number}.json 确认会话存在\n2. 使用 jq 更新状态：`jq '.status = \"active\" | .response = \"close\"' workspace/temporary-sessions/pr-{number}.json > /tmp/pr-session.tmp && mv /tmp/pr-session.tmp workspace/temporary-sessions/pr-{number}.json`\n3. 执行关闭：`gh pr close {number} --repo hs3180/disclaude`\n4. 删除会话文件：`rm workspace/temporary-sessions/pr-{number}.json`\n5. 报告执行结果",
  "later": "[用户操作] 用户选择稍后处理 PR #{number}。请执行以下步骤：\n1. 删除会话文件：`rm workspace/temporary-sessions/pr-{number}.json`\n2. 告知用户下次扫描时会重新处理此 PR"
}
```

**注意**：`send_interactive` 返回的 `messageId` 应通过 `jq` 写入会话文件的 `messageId` 字段，以便追踪关联。

## 状态转换

```
新 PR → 创建会话文件(pending) → 发送卡片 → 等待用户响应
                                              ↓ 用户点击按钮
                                    更新状态(active) → 执行操作 → 删除会话文件
                                              ↓ 超时
                                    清理过期会话(expired) → 删除会话文件
```

## 错误处理

- 如果 `gh` 命令失败，记录错误并使用 `send_text` 发送错误通知到 chatId
- 如果会话文件写入失败，记录错误并退出（不发送卡片）
- 如果发送卡片失败，删除刚创建的会话文件并记录错误
- 如果 `jq` 命令不可用，使用 Read/Write 工具代替

## 注意事项

1. **串行处理**: 一次只处理一个 PR，通过会话文件存在性检查实现
2. **文件即状态**: 所有状态通过 JSON 文件管理，不依赖 GitHub Label 或内存
3. **用户驱动**: 等待用户点击按钮后才执行操作，不自动合并或关闭
4. **自动清理**: 每次执行前清理过期会话文件
5. **幂等操作**: 重复执行不会产生副作用

## 依赖

- gh CLI
- jq（JSON 处理，如不可用则使用 Read/Write 工具）
- MCP Tool: `send_interactive`, `send_card`, `send_text`
