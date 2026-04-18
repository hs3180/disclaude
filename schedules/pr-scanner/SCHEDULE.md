---
name: "PR Scanner v2"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-04-18T00:00:00.000Z"
---

# PR Scanner v2 — Schedule Prompt

定期扫描仓库 open PR，集成 scanner.ts 状态管理和 GitHub Label 操作，完成 PR 发现 → 状态创建 → 通知的完整流程。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并行审阅数**: 3（通过 scanner.ts `check-capacity` 控制）
- **审阅超时**: 48 小时（scanner.ts 状态文件 `expiresAt`）

## 前置依赖

- `scanner.ts`（本目录下，提供 `check-capacity` / `list-candidates` / `create-state` / `mark` / `add-label` / `remove-label` 等 CLI action）
- `gh` CLI（用于获取 PR 详情和 Label 操作）
- `send_interactive` MCP 工具（发送 PR 详情卡片）

## 执行步骤

### Step 1: 检查并行容量

```bash
cd schedules/pr-scanner && npx tsx scanner.ts --action check-capacity --max-concurrent 3
```

解析 JSON 输出中的 `available` 字段。如果 `available === 0`，说明当前已有 3 个 PR 在审阅中，**退出本次执行**。

### Step 2: 获取 open PR 列表并发现候选 PR

```bash
gh pr list --repo hs3180/disclaude --state open --json number,title
```

提取所有 PR 的 `number`，组成逗号分隔的列表，然后：

```bash
cd schedules/pr-scanner && npx tsx scanner.ts --action list-candidates --pr-list "1,2,3,..."
```

解析 JSON 输出中的 `candidates` 数组。如果 `candidates` 为空，说明没有新 PR 需要处理，**退出本次执行**。

### Step 3: 选取一个候选 PR 并获取详情

取 `candidates[0]`，获取其详情：

```bash
gh pr view {number} --repo hs3180/disclaude --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

### Step 4: 创建群聊（Phase 2 回退方案）

> **当前 Phase 1**: 不创建独立群聊，使用本 Schedule 配置的 `chatId` 作为通知目标。
>
> Phase 2 将通过 lark-cli 创建独立群聊，将群聊 chatId 传入 `create-state --chat-id`。

### Step 5: 创建 PR 状态文件

```bash
cd schedules/pr-scanner && npx tsx scanner.ts --action create-state --pr {number}
```

验证输出中 `state === "reviewing"` 且 `prNumber` 正确。

### Step 6: 发送 PR 详情卡片

使用 `send_interactive` 工具（**不是** `send_card`）发送以下卡片到配置的 chatId：

```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {
      "title": {"content": "🔔 新 PR 待审阅 #{number}", "tag": "plain_text"},
      "template": "blue"
    },
    "elements": [
      {"tag": "markdown", "content": "**{title}**\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |"},
      {"tag": "markdown", "content": "### 📋 描述\n{body 前500字符}\n\n---\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve", "type": "primary"},
        {"tag": "button", "text": {"content": "❌ Request Changes", "tag": "plain_text"}, "value": "request_changes"},
        {"tag": "button", "text": {"content": "🔄 Close PR", "tag": "plain_text"}, "value": "close_pr"},
        {"tag": "button", "text": {"content": "⏳ 稍后", "tag": "plain_text"}, "value": "later"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "{当前 chatId}",
  "actionPrompts": {
    "approve": "[用户操作] 用户批准 PR #{number}。请执行以下步骤：\n1. 检查 CI 状态是否通过（查看 statusCheckRollup）\n2. 如果 CI 通过，执行 `gh pr review {number} --repo hs3180/disclaude --approve` \n3. 执行 `cd schedules/pr-scanner && npx tsx scanner.ts --action mark --pr {number} --state approved`\n4. 执行 `cd schedules/pr-scanner && npx tsx scanner.ts --action remove-label --pr {number}`\n5. 报告执行结果",
    "request_changes": "[用户操作] 用户请求 PR #{number} 修改。请询问用户需要修改的具体内容，然后：\n1. 使用 `gh pr review {number} --repo hs3180/disclaude --request-changes -b \"用户反馈\"` 提交修改请求\n2. **不改变** scanner.ts 状态（保持 reviewing），等待作者更新后重新触发\n3. 报告执行结果",
    "close_pr": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. 执行 `gh pr close {number} --repo hs3180/disclaude`\n2. 执行 `cd schedules/pr-scanner && npx tsx scanner.ts --action mark --pr {number} --state closed`\n3. 执行 `cd schedules/pr-scanner && npx tsx scanner.ts --action remove-label --pr {number}`\n4. 报告执行结果",
    "later": "[用户操作] 用户选择稍后处理 PR #{number}。跳过本次，下次扫描时仍在候选列表中。"
  }
}
```

### Step 7: 添加 GitHub Label（兜底）

```bash
cd schedules/pr-scanner && npx tsx scanner.ts --action add-label --pr {number}
```

默认添加 `pr-scanner:reviewing` label。如果 label 操作失败，JSON 输出中 `success` 为 `false`，但**不影响主流程**。

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| scanner.ts 执行失败 | 记录错误到 stderr，**退出本次执行** |
| `gh pr list` 失败 | 记录错误，发送错误通知到 chatId，**退出本次执行** |
| `gh pr view` 失败 | 跳过该 PR，处理下一个候选 |
| Label 操作失败 | **忽略**，不影响主流程（scanner.ts 返回 `success: false`） |
| send_interactive 失败 | 记录错误，PR 状态已创建但用户未收到通知，下次扫描不会重复处理 |

## 职责边界

- ✅ 检查并行审阅容量
- ✅ 发现未处理的候选 PR
- ✅ 创建 PR 状态文件
- ✅ 发送 PR 详情卡片（send_interactive）
- ✅ 添加/移除 GitHub Label
- ❌ 不创建独立群聊（Phase 2 实现）
- ❌ 不处理群聊生命周期（Sub-Issue C）
- ❌ 不处理文件锁（Sub-Issue D）

## 关联

- Parent: #2210
- Depends on: #2219 (scanner.ts)
- Related: #2221 (讨论群生命周期管理), #2222 (文件锁修复)
