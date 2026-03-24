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
- **会话存储**: `workspace/temporary-sessions/`

## 临时会话管理

本 schedule 使用 JSON 文件管理临时会话状态，不依赖 Manager 类或 TypeScript 模块。
每个 PR 审核会话对应一个 JSON 文件，直接通过文件 I/O 操作。

### 会话文件格式

文件路径: `workspace/temporary-sessions/pr-{number}.json`

```json
{
  "status": "pending",
  "chatId": null,
  "messageId": null,
  "createdAt": "2026-03-11T09:00:00Z",
  "expiresAt": "2026-03-11T10:00:00Z",
  "group": {
    "name": "PR #123: Fix auth bug",
    "members": []
  },
  "message": "🔔 PR 审核请求\nPR #123: Fix authentication bug",
  "options": [
    { "value": "merge", "text": "✅ 合并" },
    { "value": "request_changes", "text": "🔄 请求修改" },
    { "value": "close", "text": "❌ 关闭" },
    { "value": "later", "text": "⏳ 稍后" }
  ],
  "context": {
    "prNumber": 123,
    "repository": "hs3180/disclaude",
    "author": "username",
    "headRef": "feature/fix-auth",
    "baseRef": "main",
    "additions": 42,
    "deletions": 10,
    "changedFiles": 3
  },
  "response": null
}
```

### 状态定义

| 状态 | 含义 | 触发条件 |
|------|------|----------|
| `pending` | 会话已创建，等待群聊建立 | 创建 JSON 文件时 |
| `active` | 群聊已创建，等待用户响应 | 群聊创建 + 消息发送完成 |
| `expired` | 会话超时或已处理 | 用户响应 / 超时 60 分钟 |

## 执行步骤

### 0. 确保会话目录存在

```bash
mkdir -p workspace/temporary-sessions
```

### 1. 检查是否有正在处理的 PR

**双重检查机制**: 同时检查本地会话文件和 GitHub Label。

```bash
# 1a. 检查本地临时会话文件
ls workspace/temporary-sessions/pr-*.json 2>/dev/null

# 1b. 对每个活跃会话，检查是否已过期
for f in workspace/temporary-sessions/pr-*.json; do
  expires=$(cat "$f" | jq -r '.expiresAt')
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [[ "$expires" < "$now" ]]; then
    # 会话已过期，标记为 expired
    cat "$f" | jq '.status = "expired"' > "$f.tmp" && mv "$f.tmp" "$f"
    # 对应清理：移除 pending label
    pr_num=$(cat "$f" | jq -r '.context.prNumber')
    gh pr edit "$pr_num" --repo hs3180/disclaude --remove-label "pr-scanner:pending" 2>/dev/null
    # 可选：发送超时通知到群聊
    chat_id=$(cat "$f" | jq -r '.chatId')
    if [ "$chat_id" != "null" ]; then
      echo "⏰ PR #$pr_num 审核超时，已自动关闭会话"
      # 使用 send_text 发送超时通知
    fi
  fi
done

# 1c. 检查是否仍有 active 状态的会话
active_sessions=$(cat workspace/temporary-sessions/pr-*.json 2>/dev/null | jq -s '[.[] | select(.status == "active" or .status == "pending")]')
if [ "$active_sessions" != "[]" ] && [ "$active_sessions" != "" ] && [ "$active_sessions" != "null" ]; then
  echo "有活跃会话，退出本次执行"
  exit 0
fi
```

如果仍有 `active` 或未过期的 `pending` 状态的会话，**退出本次执行**。

### 2. 获取 open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open \
  --json number,title,author,labels,mergeable,statusCheckRollup,updatedAt
```

### 3. 过滤已处理的 PR

排除以下 PR：
- 已有 `pr-scanner:processed` label 的 PR
- 已有 `pr-scanner:pending` label 的 PR
- 已被 review/approve 的 PR（暂不处理）
- 本地有活跃会话文件的 PR（`workspace/temporary-sessions/pr-{number}.json` 且 status 为 `active` 或 `pending`）

### 4. 选择第一个未处理的 PR

取过滤后的第一个 PR 作为处理对象。

### 5. 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

### 6. 创建临时会话文件 ⚡ 核心步骤

**在选择 PR 后、创建群聊前**，先创建会话 JSON 文件（状态为 `pending`）：

```bash
# 计算过期时间（60 分钟后）
expires_at=$(date -u -d "+60 minutes" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+60M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# 创建会话文件
cat > "workspace/temporary-sessions/pr-{number}.json" << EOF
{
  "status": "pending",
  "chatId": null,
  "messageId": null,
  "createdAt": "${created_at}",
  "expiresAt": "${expires_at}",
  "group": {
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
    "repository": "hs3180/disclaude",
    "author": "{author}",
    "headRef": "{headRef}",
    "baseRef": "{baseRef}",
    "additions": {additions},
    "deletions": {deletions},
    "changedFiles": {changedFiles}
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

### 8. 更新会话文件为 active 状态

群聊创建成功后，更新会话文件：

```bash
# 更新状态为 active，填入实际的 chatId 和 messageId
cat "workspace/temporary-sessions/pr-{number}.json" | \
  jq '.status = "active" | .chatId = "{actual_chat_id}" | .messageId = "{actual_message_id}"' \
  > "workspace/temporary-sessions/pr-{number}.json.tmp" && \
  mv "workspace/temporary-sessions/pr-{number}.json.tmp" "workspace/temporary-sessions/pr-{number}.json"
```

### 9. 在群聊中发送交互式卡片

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
  "merge": "[用户操作] 用户批准合并 PR #{number}。请执行以下步骤：\n1. 检查 CI 状态是否通过\n2. 执行 `gh pr merge {number} --repo hs3180/disclaude --merge --delete-branch`\n3. 报告执行结果\n4. 更新会话文件为 expired：`jq '.status = \"expired\" | .response = \"merge\"' workspace/temporary-sessions/pr-{number}.json > ...`\n5. 添加 processed label 并移除 pending label",
  "request_changes": "[用户操作] 用户请求修改 PR #{number}。请询问用户需要修改的具体内容，然后使用 `gh pr comment` 添加评论。更新会话文件：`jq '.response = \"request_changes\"' workspace/temporary-sessions/pr-{number}.json > ...`",
  "close": "[用户操作] 用户关闭 PR #{number}。请执行 `gh pr close {number} --repo hs3180/disclaude` 并报告结果。更新会话文件为 expired。",
  "later": "[用户操作] 用户选择稍后处理 PR #{number}。请更新会话文件为 expired，移除 pending label，下次扫描时会重新处理。"
}
```

### 10. 添加 pending label

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:pending"
```

## 状态管理

### 双重状态追踪

| 机制 | 用途 | 持久性 |
|------|------|--------|
| **本地 JSON 文件** | 追踪群聊会话状态、超时、用户响应 | 跨重启持久 |
| **GitHub Label** | 追踪 PR 处理状态（全局可见） | 跨重启持久 |

### Label 定义

| Label | 含义 |
|-------|------|
| `pr-scanner:processed` | 已通过 scanner 处理完成 |
| `pr-scanner:pending` | 正在等待用户反馈 |

### 状态转换

```
新 PR → 创建会话 JSON (pending) → 创建群聊 → 更新 JSON (active)
  → 添加 pending label → 等待用户响应
  → 用户操作 / 超时 → 更新 JSON (expired) → 执行动作 → processed label
```

### 会话清理

过期的会话文件（status = `expired`）在每次扫描时检测，但不自动删除。
保留过期文件用于历史追溯，手动清理即可：

```bash
# 手动清理超过 24 小时的过期会话
find workspace/temporary-sessions/ -name "pr-*.json" -mtime +1 -delete
```

## 错误处理

- 如果 `gh` 命令失败，记录错误并发送错误通知
- 如果创建群聊失败，将会话文件标记为 `expired`，不添加 pending label
- 如果 JSON 文件操作失败，回退到仅使用 GitHub Label 管理状态
- 如果添加 label 失败，记录错误但不影响流程

## 注意事项

1. **群聊讨论**: 为每个 PR 创建独立群聊，便于深入讨论
2. **串行处理**: 一次只处理一个 PR，避免并发问题
3. **双重状态**: 本地 JSON 文件 + GitHub Label 双重追踪，确保状态一致性
4. **用户驱动**: 等待群聊讨论结论后才执行动作，不自动合并或关闭
5. **文件操作**: 使用 `jq` 进行 JSON 文件读写，确保原子性（先写临时文件再 mv）

## 依赖

- gh CLI
- jq (JSON 文件操作)
- GitHub Labels: `pr-scanner:processed`, `pr-scanner:pending`
- MCP Tool: `start_group_discussion` (Issue #1155)
- 会话目录: `workspace/temporary-sessions/`
