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
- **会话目录**: `workspace/temporary-sessions/`

## 会话文件格式

每个 PR 创建一个 JSON 会话文件（`workspace/temporary-sessions/pr-{number}.json`）：

```json
{
  "status": "pending",
  "chatId": null,
  "messageId": null,
  "createdAt": "2026-03-25T10:00:00Z",
  "expiresAt": "2026-03-25T11:00:00Z",
  "createGroup": {
    "name": "PR #{number} 讨论: {title}",
    "members": []
  },
  "message": "🔔 PR 审核请求\n...",
  "options": [
    { "value": "merge", "text": "✅ 合并" },
    { "value": "request_changes", "text": "🔄 请求修改" },
    { "value": "close", "text": "❌ 关闭" },
    { "value": "later", "text": "⏳ 稍后" }
  ],
  "context": {
    "prNumber": {number},
    "repository": "hs3180/disclaude"
  },
  "response": null
}
```

### 会话状态

| 状态 | 含义 |
|------|------|
| `pending` | 会话已创建，等待群聊创建 |
| `active` | 群聊已创建，等待用户响应 |
| `expired` | 超时或已处理完成 |

## 执行步骤

### 1. 检查是否有正在处理的 PR

通过会话文件检查当前状态（同时检查 GitHub Label 作为兼容）：

```bash
# 检查是否有 active 状态的会话文件
ls workspace/temporary-sessions/pr-*.json 2>/dev/null | while read f; do
  status=$(cat "$f" | jq -r '.status // "unknown"')
  if [ "$status" = "active" ] || [ "$status" = "pending" ]; then
    echo "ACTIVE: $f"
  fi
done

# 兼容：检查 GitHub Label（旧版状态管理）
gh pr list --repo hs3180/disclaude --state open \
  --label "pr-scanner:pending" \
  --json number,title
```

如果存在 active/pending 会话文件 **或** GitHub Label 检查有结果，说明有 PR 正在等待用户反馈，**退出本次执行**。

### 2. 获取 open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open \
  --json number,title,author,labels,mergeable,statusCheckRollup,updatedAt
```

### 3. 过滤已处理的 PR

排除以下 PR：
- 已有 `pr-scanner:processed` label 的 PR
- 已有对应会话文件且状态为 `expired` 的 PR（已处理过）
- 已被 review/approve 的 PR（暂不处理）

```bash
# 检查 PR 是否已有会话文件
for pr in {过滤后的PR列表}; do
  if [ -f "workspace/temporary-sessions/pr-${pr}.json" ]; then
    # 跳过已有会话文件的 PR
    continue
  fi
done
```

### 4. 选择第一个未处理的 PR

取过滤后的第一个 PR 作为处理对象。

### 5. 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

### 6. 创建会话文件

为该 PR 创建 JSON 会话文件（status: pending）：

```bash
cat > workspace/temporary-sessions/pr-{number}.json << 'SESSION_EOF'
{
  "status": "pending",
  "chatId": null,
  "messageId": null,
  "createdAt": "{当前ISO时间}",
  "expiresAt": "{当前时间+60分钟}",
  "createGroup": {
    "name": "PR #{number} 讨论: {title}",
    "members": []
  },
  "message": "🔔 PR 审核请求\nPR #{number}: {title}",
  "options": [
    { "value": "merge", "text": "✅ 合并" },
    { "value": "request_changes", "text": "🔄 请求修改" },
    { "value": "close", "text": "❌ 关闭" },
    { "value": "later", "text": "⏳ 稍后" }
  ],
  "context": {
    "prNumber": {number},
    "repository": "hs3180/disclaude"
  },
  "response": null
}
SESSION_EOF
```

### 7. 创建群聊讨论 PR

使用 `send_interactive` 工具为该 PR 发送交互式卡片（在固定 chatId 中）：

**卡片内容**（format: "card"）：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "🔔 PR 审核请求: #{number}", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "**PR #{number}**: {title}\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |\n\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ 合并", "tag": "plain_text"}, "value": "merge", "type": "primary"},
      {"tag": "button", "text": {"content": "🔄 请求修改", "tag": "plain_text"}, "value": "request_changes", "type": "default"},
      {"tag": "button", "text": {"content": "❌ 关闭", "tag": "plain_text"}, "value": "close", "type": "danger"},
      {"tag": "button", "text": {"content": "⏳ 稍后", "tag": "plain_text"}, "value": "later", "type": "default"}
    ]},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "会话将在 60 分钟后自动过期"}
    ]}
  ]
}
```

**actionPrompts**：
```json
{
  "merge": "[用户操作] 用户批准合并 PR #{number}。请执行以下步骤：\n1. 读取会话文件 workspace/temporary-sessions/pr-{number}.json\n2. 检查 CI 状态是否通过\n3. 执行 `gh pr merge {number} --repo hs3180/disclaude --merge --delete-branch`\n4. 报告执行结果\n5. 更新会话文件：设置 status 为 expired，response 为 {\"action\": \"merge\", \"result\": \"...\"}\n6. 添加 processed label 并移除 pending label",
  "request_changes": "[用户操作] 用户请求修改 PR #{number}。请执行以下步骤：\n1. 读取会话文件 workspace/temporary-sessions/pr-{number}.json\n2. 询问用户需要修改的具体内容\n3. 使用 `gh pr comment` 添加评论\n4. 更新会话文件：设置 status 为 expired，response 为 {\"action\": \"request_changes\", \"comment\": \"...\"}\n5. 移除 pending label",
  "close": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. 读取会话文件 workspace/temporary-sessions/pr-{number}.json\n2. 执行 `gh pr close {number} --repo hs3180/disclaude`\n3. 报告结果\n4. 更新会话文件：设置 status 为 expired，response 为 {\"action\": \"close\"}\n5. 移除 pending label",
  "later": "[用户操作] 用户选择稍后处理 PR #{number}。请执行以下步骤：\n1. 读取会话文件 workspace/temporary-sessions/pr-{number}.json\n2. 删除会话文件\n3. 移除 pending label\n4. 下次扫描时会重新处理"
}
```

### 8. 更新会话状态并添加 Label

群聊创建 + 卡片发送成功后，更新会话文件状态为 active：

```bash
# 更新会话状态为 active
cat workspace/temporary-sessions/pr-{number}.json | \
  jq '.status = "active" | .chatId = "{实际chatId}"' > /tmp/pr-session-update.json && \
  mv /tmp/pr-session-update.json workspace/temporary-sessions/pr-{number}.json
```

```bash
# 添加 GitHub Label（兼容旧版状态管理）
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:pending"
```

## 状态管理

### 双重状态跟踪

| 机制 | 用途 | 优势 |
|------|------|------|
| **JSON 会话文件** | 主要状态管理 | 持久化、含元数据、支持超时 |
| **GitHub Label** | 兼容/可视化 | GitHub UI 可见、跨实例共享 |

### 会话状态转换

```
创建会话文件 (pending)
  → 群聊创建+卡片发送成功 (active)
    → 用户响应/超时 (expired)
      → 清理会话文件
```

## 错误处理

- 如果 `gh` 命令失败，记录错误并发送错误通知
- 如果会话文件创建失败，回退到纯 GitHub Label 模式
- 如果发送卡片失败，删除会话文件并记录错误
- 如果更新会话状态失败，保留 pending 状态（下次扫描会跳过）

## 注意事项

1. **群聊讨论**: 为每个 PR 创建独立群聊，便于深入讨论
2. **串行处理**: 一次只处理一个 PR，避免并发问题
3. **双重状态**: JSON 会话文件为主，GitHub Label 为辅
4. **用户驱动**: 等待用户响应后才执行动作，不自动合并或关闭
5. **自动过期**: 会话超过 60 分钟后由 session-lifecycle schedule 自动处理

## 依赖

- gh CLI
- jq（JSON 文件操作）
- GitHub Labels: `pr-scanner:processed`, `pr-scanner:pending`
- Session Lifecycle Schedule: `schedules/session-lifecycle.md`
