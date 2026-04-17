---
name: "PR Scanner v2"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner v2 — Schedule Prompt

定期扫描仓库的 open PR，为未处理的 PR 创建讨论群聊并发送详情卡片。基于 scanner.ts 进行状态管理，通过 `lark-cli` 创建群组，使用 `send_interactive` 发送操作卡片。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并行审查**: 3 个（scanner.ts `check-capacity` 控制）
- **讨论超时**: 48 小时（scanner.ts `create-state` 自动设置 `expiresAt`）
- **状态目录**: `.temp-chats/`

## 前置依赖

- `scanner.ts` CLI（本目录下）
- `gh` CLI（GitHub API 操作）
- `lark-cli`（飞书群组操作，可选）

## 职责边界

- ✅ 发现未处理的 PR（通过 scanner.ts `list-candidates`）
- ✅ 容量检查（最多 3 个并行 reviewing）
- ✅ 创建讨论群聊（通过 `lark-cli`）
- ✅ 写入状态文件（通过 scanner.ts `create-state`）
- ✅ 发送 PR 详情卡片（通过 `send_interactive`）
- ✅ GitHub Label 管理（scanner.ts 自动处理）
- ❌ 不处理讨论群生命周期（由 `chat-timeout` skill 负责）
- ❌ 不处理 PR 合并/关闭操作（由用户在讨论群中触发）

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx schedules/pr-scanner/scanner.ts --action check-capacity
```

解析输出 JSON 中的 `available` 字段。如果 `available === 0`，**退出本次执行**。

### Step 2: 发现待审 PR

```bash
npx tsx schedules/pr-scanner/scanner.ts --action list-candidates --repo hs3180/disclaude
```

如果返回空数组 `[]`，**退出本次执行**。否则，取**第一个**候选 PR 进行处理。

### Step 3: 获取 PR 详情

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

从返回的 JSON 中提取：
- `title` — PR 标题
- `author.login` — 作者
- `headRefName` / `baseRefName` — 分支信息
- `mergeable` — 是否可合并
- `statusCheckRollup` — CI 检查状态
- `additions` / `deletions` / `changedFiles` — 变更统计
- `body`（截取前 300 字符）— PR 描述

### Step 4: 创建讨论群聊

**首选方案** — 通过 `lark-cli` 创建群组：

```bash
lark-cli im +chat-create --name "PR #{number} 讨论: {title前20字符}" --users ""
```

提取返回的 `chatId`（`oc_` 开头的字符串）。

**回退方案** — 如果 `lark-cli` 不可用或创建失败：
- 使用 Schedule 配置中的 `chatId`（admin 群聊）作为目标
- 在 admin 群聊中发送 PR 详情

### Step 5: 写入状态文件

```bash
npx tsx schedules/pr-scanner/scanner.ts --action create-state \
  --pr {number} --chat-id {chatId} --repo hs3180/disclaude
```

此命令会：
- 在 `.temp-chats/pr-{number}.json` 创建状态文件
- 自动添加 `pr-scanner:reviewing` GitHub Label（失败不阻塞）

如果 `create-state` 失败（状态文件已存在），**跳过此 PR**。

### Step 6: 发送 PR 详情卡片

使用 `send_interactive`（非 `send_card`）发送到 `{chatId}`：

**卡片内容**（format: "card"）：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "🔔 新 PR 检测到 #{number}", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "**{title}**\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | @{author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 🔍 CI 检查 | {ciStatus} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |"},
    {"tag": "markdown", "content": "### 📋 描述\n{body前300字符}\n\n---\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve", "type": "primary"},
      {"tag": "button", "text": {"content": "🔄 Request Changes", "tag": "plain_text"}, "value": "request_changes"},
      {"tag": "button", "text": {"content": "❌ Close PR", "tag": "plain_text"}, "value": "close", "type": "danger"},
      {"tag": "button", "text": {"content": "💬 评论", "tag": "plain_text"}, "value": "comment"}
    ]}
  ]
}
```

**actionPrompts**：
```json
{
  "approve": "[用户操作] 用户批准 PR #{number}。请执行以下步骤：\n1. 检查 CI 状态是否通过\n2. 执行 `gh pr review {number} --repo hs3180/disclaude --approve --body \"Approved via PR Scanner\"`\n3. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state approved --repo hs3180/disclaude`\n4. 报告执行结果",
  "request_changes": "[用户操作] 用户请求修改 PR #{number}。请询问用户需要修改的具体内容，然后：\n1. 获取用户输入的修改意见\n2. 执行 `gh pr review {number} --repo hs3180/disclaude --request-changes --body \"用户的修改意见\"`\n3. 报告执行结果",
  "close": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. 执行 `gh pr close {number} --repo hs3180/disclaude`\n2. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state closed --repo hs3180/disclaude`\n3. 报告执行结果",
  "comment": "[用户操作] 用户想对 PR #{number} 添加评论。请询问用户要评论的内容，然后：\n1. 获取用户输入\n2. 执行 `gh pr comment {number} --repo hs3180/disclaude --body \"用户评论内容\"`\n3. 报告执行结果"
}
```

### Step 7: 兜底 Label（可选）

如果 `create-state` 中的自动 Label 添加失败（已在 scanner.ts 中处理，此处为兜底）：

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:reviewing"
```

如果此命令也失败，**忽略错误，不阻塞主流程**。

## 状态管理

### 状态文件

scanner.ts 在 `.temp-chats/pr-{number}.json` 维护每个 PR 的状态：

```json
{
  "prNumber": 123,
  "chatId": "oc_xxx",
  "state": "reviewing",
  "createdAt": "2026-04-17T10:00:00Z",
  "updatedAt": "2026-04-17T10:00:00Z",
  "expiresAt": "2026-04-19T10:00:00Z"
}
```

### 状态枚举

| 状态 | 含义 |
|------|------|
| `reviewing` | 正在审查中，讨论群活跃 |
| `approved` | 已批准 |
| `closed` | 已关闭 |

### Label 映射

| Label | 含义 | 添加时机 | 移除时机 |
|-------|------|----------|----------|
| `pr-scanner:reviewing` | 正在审查 | `create-state` | `mark` 离开 reviewing 时 |

### 状态转换

```
新 PR → create-state (reviewing + label) → 用户操作 → mark (approved/closed + remove label)
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `check-capacity` 返回 `available === 0` | 退出本次执行 |
| `list-candidates` 返回空数组 | 退出本次执行 |
| `gh pr view` 失败 | 记录错误，跳过此 PR |
| `lark-cli` 不可用 | 回退到 admin chatId |
| `lark-cli` 创建群组失败 | 回退到 admin chatId |
| `create-state` 失败（文件已存在） | 跳过此 PR |
| Label 添加/移除失败 | 记录警告，不阻塞主流程 |
| `send_interactive` 失败 | 记录错误，继续处理 |

## 注意事项

1. **串行处理**: 每次执行只处理 1 个 PR（取第一个候选），避免并发问题
2. **容量限制**: 最多 3 个并行 reviewing PR，超出则等待
3. **幂等性**: `create-state` 检测已有文件时会失败，防止重复处理
4. **Label 兜底**: scanner.ts 自动管理 Label，失败仅记录警告
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只处理 `.temp-chats/` 目录下的状态文件
