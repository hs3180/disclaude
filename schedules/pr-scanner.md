---
name: "PR Scanner (Serial)"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner - 串行扫描模式

定期扫描仓库的 open PR，串行处理，为每个 PR 创建讨论群聊。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **讨论超时**: 60 分钟

## 执行步骤

### 1. 检查是否有正在处理的 PR

**重要**: 由于 schedule 是无状态的，需要通过 GitHub Label 判断当前状态。

```bash
# 检查是否有带 pr-scanner:pending label 的 PR
gh pr list --repo hs3180/disclaude --state open \
  --label "pr-scanner:pending" \
  --json number,title
```

如果返回结果不为空，说明有 PR 正在等待用户反馈，**退出本次执行**。

### 1.5 清理过期会话文件

检查 `workspace/temporary-sessions/` 目录中过期的会话文件，清理已过期超过 24 小时的文件：

```bash
# 列出所有会话文件
ls workspace/temporary-sessions/*.json 2>/dev/null || echo "No sessions"
```

对于每个文件，检查 `status` 和 `updatedAt`：
- 如果 `status` 为 `"expired"` 且 `updatedAt` 超过 24 小时前 → 删除文件
- 如果 `status` 为 `"active"` 且 `expiresAt` 已过 → 更新为 `"expired"`（超时未响应）

```bash
# 示例：检查并更新过期会话（使用 jq）
cat workspace/temporary-sessions/pr-{number}.json | jq '.status'
```

### 2. 获取 open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open \
  --json number,title,author,labels,mergeable,statusCheckRollup,updatedAt
```

### 3. 过滤已处理的 PR

排除以下 PR：
- 已有 `pr-scanner:processed` label 的 PR
- 已被 review/approve 的 PR（暂不处理）

### 4. 选择第一个未处理的 PR

取过滤后的第一个 PR 作为处理对象。

### 5. 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

### 6. 创建会话文件 ⚡ JSON 会话管理

在创建群聊之前，先创建 JSON 会话文件（参考 Issue #1317 临时会话管理系统设计）：

```bash
# 创建会话文件
cat > workspace/temporary-sessions/pr-{number}.json << 'EOF'
{
  "id": "pr-{number}",
  "status": "pending",
  "chatId": null,
  "messageId": null,
  "expiresAt": "{当前时间 + 60 分钟，ISO 格式}",
  "createdAt": "{当前时间，ISO 格式}",
  "updatedAt": "{当前时间，ISO 格式}",
  "createGroup": {
    "name": "PR #{number} 讨论: {title}",
    "members": []
  },
  "message": "🔔 PR 审核请求\n**PR #{number}**: {title}",
  "options": [
    {"value": "merge", "text": "✅ 合并"},
    {"value": "request_changes", "text": "🔄 请求修改"},
    {"value": "close", "text": "❌ 关闭"},
    {"value": "later", "text": "⏳ 稍后"}
  ],
  "context": {
    "prNumber": {number},
    "repository": "hs3180/disclaude",
    "type": "pr-scanner"
  },
  "response": null
}
EOF
```

### 7. 创建群聊讨论 PR

使用 `start_group_discussion` 工具为该 PR 创建专门的讨论群聊：

```json
{
  "topic": "PR #{number} 讨论: {title}",
  "members": [],
  "context": "## 🔔 新 PR 检测到\n\n**PR #{number}**: {title}\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 🔍 CI 检查 | {ciStatus} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |\n\n### 📋 描述\n{description 前300字符}\n\n---\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})\n\n请在群聊中讨论后决定处理方式。",
  "timeout": 60
}
```

**注意**：
- `members` 留空，表示只邀请当前用户
- 群聊名称格式：`PR #{number} 讨论: {PR标题}`
- 讨论超时：60 分钟

### 8. 在群聊中发送交互式卡片

群聊创建后，使用 `send_interactive` 发送操作选项卡片：

**卡片内容**（format: "card"）：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "🎯 请选择处理方式", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ 合并", "tag": "plain_text"}, "value": "merge", "type": "primary"},
      {"tag": "button", "text": {"content": "🔄 请求修改", "tag": "plain_text"}, "value": "request_changes", "type": "default"},
      {"tag": "button", "text": {"content": "❌ 关闭", "tag": "plain_text"}, "value": "close", "type": "danger"},
      {"tag": "button", "text": {"content": "⏳ 稍后", "tag": "plain_text"}, "value": "later", "type": "default"}
    ]},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "讨论完成后请选择操作"}
    ]}
  ]
}
```

**actionPrompts**：
```json
{
  "merge": "[用户操作] 用户批准合并 PR #{number}。请执行以下步骤：\n1. 更新会话文件 workspace/temporary-sessions/pr-{number}.json：设置 status 为 \"expired\"，response 为 {\"selectedValue\": \"merge\", \"responder\": \"user\", \"repliedAt\": \"{当前时间}\"}\n2. 检查 CI 状态是否通过\n3. 执行 `gh pr merge {number} --repo hs3180/disclaude --merge --delete-branch`\n4. 报告执行结果\n5. 添加 processed label 并移除 pending label",
  "request_changes": "[用户操作] 用户请求修改 PR #{number}。请执行以下步骤：\n1. 更新会话文件 workspace/temporary-sessions/pr-{number}.json：设置 status 为 \"expired\"，response 为 {\"selectedValue\": \"request_changes\", \"responder\": \"user\", \"repliedAt\": \"{当前时间}\"}\n2. 询问用户需要修改的具体内容，然后使用 `gh pr comment` 添加评论。",
  "close": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. 更新会话文件 workspace/temporary-sessions/pr-{number}.json：设置 status 为 \"expired\"，response 为 {\"selectedValue\": \"close\", \"responder\": \"user\", \"repliedAt\": \"{当前时间}\"}\n2. 执行 `gh pr close {number} --repo hs3180/disclaude` 并报告结果。",
  "later": "[用户操作] 用户选择稍后处理 PR #{number}。请执行以下步骤：\n1. 更新会话文件 workspace/temporary-sessions/pr-{number}.json：设置 status 为 \"expired\"，response 为 {\"selectedValue\": \"later\", \"responder\": \"user\", \"repliedAt\": \"{当前时间}\"}\n2. 移除 pending label，下次扫描时会重新处理。"
}
```

### 9. 添加 pending label

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:pending"
```

### 10. 更新会话状态为 active

群聊创建和消息发送成功后，更新会话文件状态：

```bash
# 使用 jq 更新会话文件（如果 jq 不可用，手动编辑 JSON 文件）
# 设置：status → "active"，chatId → 新建群聊的 chatId，messageId → 发送消息的 messageId
cat workspace/temporary-sessions/pr-{number}.json
```

更新内容：
- `status`: `"active"`
- `chatId`: `"{群聊的 chatId}"`
- `messageId`: `"{发送卡片的 messageId}"`
- `updatedAt`: `"{当前时间，ISO 格式}"`

## 状态管理

### 双重状态跟踪

PR Scanner 使用 **GitHub Label + JSON 会话文件** 双重状态跟踪：

| 机制 | 用途 | 优势 |
|------|------|------|
| GitHub Labels | 跨执行持久化、快速查询 | 无状态 schedule 兼容 |
| JSON 会话文件 | 存储完整会话上下文（chatId、messageId、超时时间等） | 支持超时管理、会话恢复 |

### Label 定义

| Label | 含义 |
|-------|------|
| `pr-scanner:processed` | 已通过 scanner 处理完成 |
| `pr-scanner:pending` | 正在等待用户反馈 |

### 会话文件状态转换

```
pending → active → expired
              ↘ (timeout)
```

| 状态 | 触发 | 执行者 |
|------|------|--------|
| `pending` | 创建会话文件 | Schedule（步骤 6） |
| `active` | 群聊创建 + 卡片发送完成 | Schedule（步骤 10） |
| `expired` | 用户响应 OR 超时 | Action Prompt / Schedule（步骤 1.5） |

### 会话文件格式

```json
{
  "id": "pr-{number}",
  "status": "pending|active|expired",
  "chatId": "oc_xxx 或 null",
  "messageId": "om_xxx 或 null",
  "expiresAt": "2026-03-27T11:00:00Z",
  "createdAt": "2026-03-27T10:00:00.000Z",
  "updatedAt": "2026-03-27T10:00:00.000Z",
  "createGroup": {"name": "PR #123 讨论: Fix bug", "members": []},
  "message": "🔔 PR 审核请求...",
  "options": [{"value": "merge", "text": "✅ 合并"}, ...],
  "context": {"prNumber": 123, "repository": "hs3180/disclaude", "type": "pr-scanner"},
  "response": null 或 {"selectedValue": "merge", "responder": "user", "repliedAt": "..."}
}
```

### 状态转换

```
新 PR → 创建会话文件(pending) → 创建讨论群聊 → 添加 pending label → 更新会话(active)
    → 等待群聊讨论结论 → 更新会话(expired) → 执行动作 → 添加 processed label → 移除 pending label
```

## 错误处理

- 如果 `gh` 命令失败，记录错误并发送错误通知
- 如果创建群聊失败，删除会话文件并回退到在固定 chatId 中发送消息
- 如果添加 label 失败，记录错误但不影响流程
- 如果会话文件操作失败，不影响主流程（Label 状态跟踪作为降级方案）

## 注意事项

1. **群聊讨论**: 为每个 PR 创建独立群聊，便于深入讨论
2. **串行处理**: 一次只处理一个 PR，避免并发问题
3. **双重状态**: GitHub Label 保证跨执行查询，JSON 会话文件提供完整上下文
4. **用户驱动**: 等待群聊讨论结论后才执行动作，不自动合并或关闭
5. **会话超时**: 60 分钟未响应自动过期（步骤 1.5 清理）
6. **优雅降级**: JSON 会话文件操作失败不影响主流程

## 依赖

- gh CLI
- jq（可选，用于 JSON 文件操作）
- GitHub Labels: `pr-scanner:processed`, `pr-scanner:pending`
- MCP Tool: `start_group_discussion` (Issue #1155)
- 会话目录: `workspace/temporary-sessions/`
