---
name: "PR Scanner"
cron: "0 */30 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner - 核心扫描流程

定期扫描仓库的 open PR，为新 PR 创建讨论群并发送审查卡片，检测已跟踪 PR 的状态变更。

Related: #2945, #2983, #2984, #2985

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 30 分钟
- **并发上限**: 最多同时 review 3 个 PR
- **映射文件**: `workspace/pr-chat-mapping.json`

## 前置依赖

- `gh` CLI（GitHub CLI，已认证）
- `lark-cli`（飞书 CLI，用于创建讨论群）

## 数据结构

### 映射文件 (`workspace/pr-chat-mapping.json`)

```json
{
  "pr-2982": {
    "prNumber": 2982,
    "chatId": "oc_xxxxxxxxxxxxx",
    "purpose": "pr-review",
    "status": "active",
    "createdAt": "2026-04-28T10:00:00Z"
  }
}
```

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| key | string | 格式: `pr-{number}` |
| prNumber | number | GitHub PR 编号 |
| chatId | string | 飞书讨论群 ID |
| purpose | string | 固定值: `pr-review` |
| status | string | `active` / `closed` |
| createdAt | string | ISO 8601 创建时间 |

## 执行步骤

### Step 0: 并发控制检查

读取 `workspace/pr-chat-mapping.json`，统计 `status=active` 且 `purpose=pr-review` 的条目数。

**如果活跃 review 数 >= 3**，输出日志并退出本次执行：

```
INFO: 已有 3 个活跃 PR review，跳过本次扫描
```

### Step 1: 获取 Open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open \
  --json number,title,author,headRefName,baseRefName,updatedAt
```

记录返回的 PR 列表。

### Step 2: 读取映射表

读取 `workspace/pr-chat-mapping.json`（如果文件不存在或为空，视为空映射 `{}`）。

### Step 3: 分区处理

将 PR 列表分为两组：

**A. 新 PR（不在映射表中）**：进入 Step 4
**B. 已跟踪 PR（在映射表中且 status=active）**：进入 Step 6

### Step 4: 处理新 PR（串行）

对每个新 PR（从 Step 3 的 A 组），按 PR number 升序处理：

#### 4.1 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,additions,deletions,changedFiles,mergeable,statusCheckRollup
```

#### 4.2 创建讨论群

使用 `lark-cli` 创建讨论群：

```bash
lark-cli im +chat-create \
  --name "PR #{number} · {title前30字}" \
  --bot_id $BOT_ID
```

**群命名规则**：
- 格式：`PR #{number} · {title前30字}`
- title 超过 30 字符用 `...` 省略
- 必须以 `PR #` 开头

解析返回的 JSON 获取 `chat_id`。

**错误处理**：
- 如果群创建失败，记录错误日志，跳过此 PR，下一轮重试
- 如果映射文件写入失败，记录错误但不影响后续处理

#### 4.3 写入映射表

将新映射条目写入 `workspace/pr-chat-mapping.json`：

```json
{
  "pr-{number}": {
    "prNumber": {number},
    "chatId": "{返回的 chat_id}",
    "purpose": "pr-review",
    "status": "active",
    "createdAt": "{当前 ISO 8601 时间}"
  }
}
```

使用原子写入（写临时文件后 rename）以防止数据丢失。

#### 4.4 发送 PR 详情卡片

向新建的讨论群发送 PR 详情卡片（format: "card"）：

```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "PR Review #{number}", "tag": "plain_text"}, "template": "blue"},
    "elements": [
      {"tag": "markdown", "content": "📝 **标题**: {title}\n👤 **作者**: {author}\n🔀 **分支**: {headRef} → {baseRef}\n📏 **变更**: +{additions} -{deletions} ({changedFiles} files)"},
      {"tag": "hr"},
      {"tag": "markdown", "content": "📋 **描述**:\n{body 前500字}"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve", "type": "primary"},
        {"tag": "button", "text": {"content": "❌ Close", "tag": "plain_text"}, "value": "close", "type": "danger"},
        {"tag": "button", "text": {"content": "💬 Review", "tag": "plain_text"}, "value": "review"}
      ]},
      {"tag": "note", "elements": [
        {"tag": "plain_text", "content": "🔗 View PR: https://github.com/hs3180/disclaude/pull/{number}"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "{chat_id}",
  "actionPrompts": {
    "approve": "[用户操作] 用户批准合并 PR #{number}。请执行: 1. 检查 CI 状态 2. 执行 `gh pr review {number} --repo hs3180/disclaude --approve` 3. 报告结果",
    "close": "[用户操作] 用户关闭 PR #{number}。请执行 `gh pr close {number} --repo hs3180/disclaude` 并报告结果。",
    "review": "[用户操作] 用户请求深度 Review PR #{number}。请执行 `gh pr diff {number} --repo hs3180/disclaude` 后进行详细代码审查，将结果发送到当前群。"
  }
}
```

### Step 5: 并发检查

每处理完一个新 PR 后，重新检查活跃 review 数。如果已达上限（3 个），停止处理新 PR，等待下一轮扫描。

### Step 6: 检测已跟踪 PR 的状态变更

对每个已跟踪的 PR（Step 3 的 B 组），检查其是否仍在 open PR 列表中：

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json state,mergedAt,closedAt
```

#### 6.1 PR 已合并 (state=MERGED)

向讨论群发送合并通知卡片：

```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "✅ PR #{number} has been merged", "tag": "plain_text"}, "template": "green"},
    "elements": [
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "解散群", "tag": "plain_text"}, "value": "disband", "type": "danger"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "{chat_id}",
  "actionPrompts": {
    "disband": "[用户操作] 用户确认解散 PR #{number} 讨论群。请执行: 1. lark-cli im chat disband --chat_id {chat_id} 2. 更新 workspace/pr-chat-mapping.json 将 status 改为 closed"
  }
}
```

#### 6.2 PR 已关闭未合并 (state=CLOSED)

向讨论群发送关闭通知卡片：

```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "❌ PR #{number} has been closed without merge", "tag": "plain_text"}, "template": "red"},
    "elements": [
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "解散群", "tag": "plain_text"}, "value": "disband", "type": "danger"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "{chat_id}",
  "actionPrompts": {
    "disband": "[用户操作] 用户确认解散 PR #{number} 讨论群。请执行: 1. lark-cli im chat disband --chat_id {chat_id} 2. 更新 workspace/pr-chat-mapping.json 将 status 改为 closed"
  }
}
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `gh pr list` 失败 | 记录错误，退出本次执行 |
| 映射文件读取失败 | 视为空映射，继续执行（fail-open） |
| 映射文件写入失败 | 记录错误，不回滚已创建的群 |
| `lark-cli` 群创建失败 | 记录错误，跳过此 PR，下一轮重试 |
| `send_message` 卡片发送失败 | 记录错误，不回滚映射和群创建 |
| PR 状态检查失败 | 记录错误，跳过此 PR 状态变更检测 |

## 注意事项

1. **串行处理**: 一次处理一个新 PR，避免并发问题
2. **文件映射状态**: 所有状态通过 `workspace/pr-chat-mapping.json` 管理，不依赖 GitHub Labels
3. **用户驱动**: 不自动合并或关闭 PR，等待用户通过卡片按钮操作
4. **群不解散**: Bot 不自动解散群，所有解散操作由用户主动触发
5. **幂等性**: 重复执行不会产生副作用（映射表过滤已处理的 PR）
6. **不创建新 Schedule**: 这是定时任务执行环境的规则
7. **原子写入**: 映射文件更新使用临时文件 + rename 防止数据损坏

## 验证标准

- [ ] 扫描循环能正确获取 Open PR 列表
- [ ] 映射表过滤逻辑正确
- [ ] 新 PR 能触发群创建 + 卡片发送
- [ ] PR 状态变更（merged/closed）能触发通知
- [ ] 并发限制（最多 3 个活跃 review）生效
- [ ] 错误处理：gh CLI 失败 / lark-cli 失败 / 映射表读写失败
