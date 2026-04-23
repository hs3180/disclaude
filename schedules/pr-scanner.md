---
name: "PR Scanner (Serial)"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner - 串行扫描模式

定期扫描仓库的 open PR，串行处理，为每个 PR 创建讨论群聊并发送交互式卡片。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并行数**: 3（最多同时 3 个 PR 处于 reviewing 状态）
- **讨论超时**: 48 小时（状态文件 `expiresAt` 自动过期）

## 前置依赖

- `gh` CLI（GitHub API 操作）
- `@larksuite/cli`（飞书官方 CLI，群组创建，可选 — 不可用时回退到 admin chatId）
- `scanner.ts`（PR Scanner CLI 工具，可选 — 不可用时使用 gh CLI 直接操作）

> **⚠️ 容错设计**: scanner.ts 不可用时不影响核心流程。所有 scanner.ts 步骤均有 gh CLI 回退方案。

## 执行步骤

### Step 1: 检查并行容量

**目标**: 确保不超过最大并行数（max 3 reviewing）。

```bash
# 优先使用 scanner.ts（如可用）
npx tsx schedules/pr-scanner/scanner.ts --action check-capacity 2>/dev/null || {
  # 回退: 通过 gh CLI 计数 reviewing label 的 PR
  COUNT=$(gh pr list --repo hs3180/disclaude --state open --label "pr-scanner:reviewing" --json number --jq 'length')
  echo "{\"reviewing\": $COUNT, \"maxConcurrent\": 3, \"available\": $((3 - COUNT))}"
}
```

如果 `available` ≤ 0（已有 3 个 PR 在 reviewing），**退出本次执行**。

### Step 2: 发现待审 PR

**目标**: 找到未被 scanner 跟踪的 open PR。

```bash
# 优先使用 scanner.ts（如可用）
npx tsx schedules/pr-scanner/scanner.ts --action list-candidates 2>/dev/null || {
  # 回退: 使用 gh CLI 获取所有 open PR，手动过滤
  gh pr list --repo hs3180/disclaude --state open \
    --json number,title,author,labels,mergeable,statusCheckRollup,updatedAt
}
```

**过滤规则**:
- 排除已有 `pr-scanner:reviewing` label 的 PR
- 排除已有 `pr-scanner:processed` label 的 PR
- 排除已被 review/approve 的 PR

### Step 3: 选择第一个未处理的 PR

取过滤后的第一个 PR 作为处理对象。如无符合条件的 PR，**退出本次执行**。

### Step 4: 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

### Step 5: 创建讨论群聊

**优先方案**（lark-cli 可用时）: 通过 `lark-cli` 创建群聊。

```bash
lark-cli im +chat-create --name "PR #{number} 讨论: {title}" --users ""
```

解析返回结果获取 `chatId`。

**回退方案**（lark-cli 不可用或创建失败时）: 使用 admin chatId（本 Schedule 的 `chatId` 字段）作为消息目标，记录警告。

### Step 6: 创建状态文件

**目标**: 写入 `.temp-chats/pr-{number}.json` 跟踪 PR 处理状态。

```bash
# 优先使用 scanner.ts（如可用）
npx tsx schedules/pr-scanner/scanner.ts --action create-state --pr {number} 2>/dev/null || {
  # 回退: 手动创建状态文件
  mkdir -p .temp-chats
  NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  EXPIRES=$(date -u -d "+48 hours" +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || date -u -v+48H +"%Y-%m-%dT%H:%M:%S.000Z")
  cat > ".temp-chats/pr-${number}.json" << EOF
{
  "prNumber": ${number},
  "chatId": ${CHAT_ID:-null},
  "state": "reviewing",
  "createdAt": "$NOW",
  "updatedAt": "$NOW",
  "expiresAt": "$EXPIRES"
}
EOF
}
```

### Step 7: 发送 PR 详情 + 操作卡片

使用 `send_interactive`（**非** `send_card`）发送交互式卡片到目标 chatId（Step 5 获取的群聊 chatId，或回退到 admin chatId）。

**send_interactive 参数**:

`chatId`: Step 5 获取的 chatId（回退时使用 admin chatId）

`content`（卡片 JSON）:
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "🔔 PR #{number} 待审", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "**PR #{number}**: {title}\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |"},
    {"tag": "markdown", "content": "### 📋 描述\n{description 前300字符}\n\n---\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve", "type": "primary"},
      {"tag": "button", "text": {"content": "🔄 Close PR", "tag": "plain_text"}, "value": "close", "type": "danger"}
    ]}
  ]
}
```

**actionPrompts**:
```json
{
  "approve": "[用户操作] 用户批准 PR #{number}。请执行以下步骤：\n1. 检查 CI 状态是否通过（`gh pr view {number} --json statusCheckRollup`）\n2. 执行 `gh pr review {number} --repo hs3180/disclaude --approve` 批准 PR\n3. 更新状态：`npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state approved`（回退：手动更新 .temp-chats/pr-{number}.json 的 state 为 approved）\n4. 移除 `pr-scanner:reviewing` label\n5. 报告执行结果",
  "close": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. 执行 `gh pr close {number} --repo hs3180/disclaude` 关闭 PR\n2. 更新状态：`npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state closed`（回退：手动更新 .temp-chats/pr-{number}.json 的 state 为 closed）\n3. 移除 `pr-scanner:reviewing` label\n4. 报告执行结果"
}
```

### Step 8: 添加 reviewing label（兜底）

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:reviewing"
```

**注意**: Label 操作失败不阻塞主流程，仅记录警告。

## 状态管理

### Label 定义

| Label | 含义 |
|-------|------|
| `pr-scanner:reviewing` | PR 正在被 scanner 跟踪，等待用户审核 |
| `pr-scanner:processed` | PR 已通过 scanner 处理完成（用户做出决定后） |

### 状态文件（`.temp-chats/pr-{number}.json`）

```json
{
  "prNumber": 123,
  "chatId": "oc_xxx",
  "state": "reviewing",
  "createdAt": "2026-04-21T10:00:00.000Z",
  "updatedAt": "2026-04-21T10:00:00.000Z",
  "expiresAt": "2026-04-23T10:00:00.000Z"
}
```

**state 枚举**: `reviewing` → `approved` | `closed`

### 状态转换

```
新 PR → [Step 1-4: 发现] → [Step 5: 创建群聊] → [Step 6: 创建状态文件] → [Step 7: 发送卡片] → [Step 8: 添加 reviewing label]
                                                                                                                  ↓
                                                                                                          等待用户操作
                                                                                                                  ↓
                                                                                              approve → 批准 PR + mark approved + 移除 label
                                                                                              close   → 关闭 PR + mark closed + 移除 label
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| scanner.ts 不可用 | 回退到 gh CLI 直接操作，不影响核心流程 |
| lark-cli 不可用 | 回退到 admin chatId 发送卡片，记录警告 |
| gh CLI 失败 | 记录错误，跳过当前 PR，不阻塞后续执行 |
| Label 操作失败 | 忽略错误，不阻塞主流程 |
| 群聊创建失败 | 回退到 admin chatId 发送消息 |
| 状态文件写入失败 | 记录警告，Label 作为状态兜底 |

## 注意事项

1. **容量限制**: 最多同时处理 3 个 reviewing PR，防止消息轰炸
2. **串行处理**: 每次执行只处理 1 个新 PR
3. **双重状态**: Label（`pr-scanner:reviewing`）+ 状态文件（`.temp-chats/`）互为备份
4. **容错设计**: scanner.ts / lark-cli 不可用时均有回退方案
5. **用户驱动**: 等待用户点击按钮后才执行动作，不自动合并或关闭
6. **幂等性**: 重复执行不会产生副作用（Label 和状态文件均为幂等操作）

## 依赖

- gh CLI（必需）
- GitHub Labels: `pr-scanner:reviewing`, `pr-scanner:processed`（必需，自动创建如不存在）
- `scanner.ts`（可选，提供更好的状态管理）
- `@larksuite/cli`（可选，用于创建讨论群聊）
- MCP Tool: `send_interactive`（必需，发送交互式卡片）

Related: #2220
Parent: #2210
Depends on: #2219
