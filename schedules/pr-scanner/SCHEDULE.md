---
name: "PR Scanner"
cron: "*/30 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner — 映射表驱动扫描

定期扫描仓库的 open PR，通过映射表 (`workspace/bot-chat-mapping.json`) 追踪已创建的讨论群，为新 PR 创建群聊并发送审查卡片，对已合并/已关闭 PR 发送通知。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 30 分钟
- **并发上限**: 最多同时 review 3 个 PR（通过映射表中 `purpose: 'pr-review'` 的条目数判断）

## 核心数据结构

映射文件路径: `workspace/bot-chat-mapping.json`（由 `BotChatMappingStore` 管理）

```json
{
  "pr-123": { "chatId": "oc_xxx", "createdAt": "2026-04-28T10:00:00Z", "purpose": "pr-review" },
  "pr-456": { "chatId": "oc_yyy", "createdAt": "2026-04-28T11:00:00Z", "purpose": "pr-review" }
}
```

- **Key 格式**: `pr-{number}`（可通过 `purposeFromKey()` 推断 purpose）
- **群名格式**: `PR #{number} · {title前30字}`（可通过 `parseGroupNameToKey()` 解析 key）

## 执行步骤

### 1. 读取映射表

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

解析映射表中所有 `purpose: 'pr-review'` 的条目，提取已有的 PR number 列表和对应的 chatId。

**如果没有映射文件或文件为空**，视为空映射表（首次运行场景）。

### 2. 获取 Open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open \
  --json number,title,author,headRefName
```

### 3. 过滤与分类

将获取到的 PR 分为两类：

- **新 PR**：PR number 不在映射表中（`pr-{number}` key 不存在）
- **已有群的 PR**：PR number 在映射表中存在

### 4. 处理已有群的 PR — 状态变更检测

对每个已有群的 PR，检查 PR 是否已关闭/已合并：

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json state,mergedAt,closedAt
```

**如果 PR 已 merged**：
1. 在讨论群发送合并通知卡片（见下方卡片模板）
2. **不要**自动解散群或删除映射（解散必须用户主动触发）

**如果 PR 已 closed (not merged)**：
1. 在讨论群发送关闭通知卡片（见下方卡片模板）
2. **不要**自动解散群或删除映射

**如果 PR 仍 open**：跳过，无需操作。

### 5. 处理新 PR — 创建讨论群

**并发检查**：统计映射表中 `purpose: 'pr-review'` 的条目数，如果 ≥ 3，跳过新 PR 创建，下一轮扫描再处理。

对每个新 PR（按 number 升序）：

#### 5a. 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,additions,deletions,changedFiles,mergeable,statusCheckRollup
```

#### 5b. 创建讨论群

使用 `lark-cli` 创建群聊：

```bash
lark-cli im chat create \
  --name "PR #{number} · {title前30字}" \
  --description "PR #{number} 审查讨论群"
```

从返回结果中提取 `chatId`。

**如果创建失败**：记录错误，跳过此 PR，继续处理下一个。

#### 5c. 写入映射表

将新映射条目写入 `workspace/bot-chat-mapping.json`：

```json
{
  "pr-{number}": {
    "chatId": "{新建群的chatId}",
    "createdAt": "{ISO时间戳}",
    "purpose": "pr-review"
  }
}
```

**注意**：保留映射表中已有的所有条目，仅追加新条目。使用原子写入（先写临时文件再重命名）。

#### 5d. 发送 PR 审查卡片

使用 `send_interactive` 向新创建的讨论群发送 PR 详情 + 操作按钮卡片。

**卡片内容**：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "PR Review #{number}", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "**{title}**\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | @{author} |\n| 🔀 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |"},
    {"tag": "markdown", "content": "### 📋 描述\n{body前500字符}"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve_{number}", "type": "primary"},
      {"tag": "button", "text": {"content": "💬 Review", "tag": "plain_text"}, "value": "review_{number}", "type": "default"},
      {"tag": "button", "text": {"content": "❌ Close", "tag": "plain_text"}, "value": "close_{number}", "type": "danger"}
    ]},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})"}
    ]}
  ]
}
```

**actionPrompts**：
```json
{
  "approve_{number}": "[用户操作] 用户批准 PR #{number}。请执行：1. 检查 CI 状态 2. `gh pr review {number} --repo hs3180/disclaude --approve` 3. 报告结果",
  "review_{number}": "[用户操作] 用户请求深入审查 PR #{number}。请使用 `gh pr diff {number}` 查看变更，进行 code review，将审查结果发送到当前群聊。",
  "close_{number}": "[用户操作] 用户关闭 PR #{number}。请执行 `gh pr close {number} --repo hs3180/disclaude` 并报告结果。"
}
```

### 6. PR 状态变更通知卡片模板

**Merged 通知**：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "✅ PR #{number} has been merged", "tag": "plain_text"}, "template": "green"},
  "elements": [
    {"tag": "markdown", "content": "**{title}** 已成功合并到 `{baseRef}`。"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "解散群", "tag": "plain_text"}, "value": "disband_{number}", "type": "danger"}
    ]}
  ]
}
```

**Closed 通知**：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "❌ PR #{number} has been closed", "tag": "plain_text"}, "template": "red"},
  "elements": [
    {"tag": "markdown", "content": "**{title}** 已被关闭（未合并）。"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "解散群", "tag": "plain_text"}, "value": "disband_{number}", "type": "danger"}
    ]}
  ]
}
```

**disband actionPrompts**：
```json
{
  "disband_{number}": "[用户操作] 用户请求解散 PR #{number} 的讨论群。请：1. 确认解散意图（二次确认） 2. 执行 `lark-cli im chat disband --chat_id {chatId}` 3. 从 workspace/bot-chat-mapping.json 中删除 pr-{number} 条目 4. 报告结果"
}
```

## 错误处理

| 场景 | 处理 |
|------|------|
| `gh pr list` 失败 | 记录错误，退出本次执行 |
| `gh pr view` 失败 | 跳过该 PR，继续处理下一个 |
| 映射文件读取失败 | 视为空映射表 |
| 映射文件写入失败 | 记录错误，群已创建但映射丢失（可通过群名重建） |
| 群创建失败 | 记录错误，跳过该 PR |
| 卡片发送失败 | 记录错误，群已创建（下次扫描不会重复创建） |

## 设计原则

1. **映射表是缓存**：所有数据可从飞书 API 重建（`lark-cli im chats list --as bot` + 群名规则匹配）
2. **用户驱动解散**：Bot 不自主解散群，所有解散操作必须由用户点击卡片按钮触发
3. **幂等操作**：重复扫描不会重复创建群或重复发送卡片（通过映射表过滤）
4. **无 GitHub Label 依赖**：所有状态通过映射表管理，不使用 `pr-scanner:pending` / `pr-scanner:processed` 等 label

## 依赖

- `gh` CLI — GitHub PR 操作
- `lark-cli` — 飞书群聊创建/解散
- `send_interactive` MCP 工具 — 发送交互式卡片
- `workspace/bot-chat-mapping.json` — PR↔群映射表（BotChatMappingStore 格式）

## 关联

- Parent: #2945
- Depends on: #2947 (BotChatMappingStore), #2946 (移除 register_temp_chat)
