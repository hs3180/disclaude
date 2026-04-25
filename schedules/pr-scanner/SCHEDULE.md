---
name: "PR Scanner v2"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner v2 — Schedule Prompt

定期扫描仓库的 open PR，使用 scanner.ts 管理状态，通过 `send_interactive` 发送交互式卡片进行审阅。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并行审阅**: 3
- **审阅超时**: 48 小时（由 scanner.ts expiresAt 管理）
- **状态目录**: `.temp-chats/`

## 前置依赖

- `scanner.ts`（同目录下）— 状态管理 CLI
- `gh` CLI — GitHub API 操作
- `send_interactive` MCP tool — 发送交互式卡片

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx schedules/pr-scanner/scanner.ts --action check-capacity
```

解析输出 JSON:
```json
{ "reviewing": 2, "maxConcurrent": 3, "available": 1 }
```

**如果 `available === 0`，退出本次执行**（已达并行上限）。

### Step 2: 发现待审 PR

```bash
npx tsx schedules/pr-scanner/scanner.ts --action list-candidates
```

解析输出 JSON（无状态文件的 open PR 列表）:
```json
[
  { "number": 123, "title": "feat: some feature" },
  { "number": 124, "title": "fix: some bug" }
]
```

**如果列表为空 `[]`，退出本次执行**（无新 PR）。

**取第一个候选 PR** 作为本次处理对象。

### Step 3: 获取 PR 详情

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

### Step 4: 创建状态文件

```bash
npx tsx schedules/pr-scanner/scanner.ts --action create-state --pr {number}
```

此命令同时为 PR 添加 `pr-scanner:reviewing` GitHub Label（非阻塞，失败不影响主流程）。

输出新创建的状态文件内容:
```json
{
  "prNumber": 123,
  "chatId": null,
  "state": "reviewing",
  "createdAt": "...",
  "updatedAt": "...",
  "expiresAt": "...",
  "disbandRequested": null
}
```

### Step 5: 发送 PR 详情 + 操作卡片

使用 `send_interactive` 发送交互式卡片到本 Schedule 的 chatId:

```json
{
  "chatId": "{本 Schedule 的 chatId}",
  "title": "🔔 新 PR 检测到",
  "context": "## PR #{number}: {title}\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |\n\n### 📋 描述\n{body 前500字符}\n\n---\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})",
  "question": "请选择处理方式：",
  "options": [
    { "text": "✅ Approve", "value": "approve", "type": "primary" },
    { "text": "❌ Request Changes", "value": "request_changes" },
    { "text": "🔄 Close PR", "value": "close" }
  ],
  "actionPrompts": {
    "approve": "[用户操作] 用户批准 PR #{number}。请执行：\n1. `gh pr review {number} --repo hs3180/disclaude --approve --body \"LGTM! Approved via PR Scanner.\"`\n2. `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state approved`\n3. 报告执行结果",
    "request_changes": "[用户操作] 用户请求修改 PR #{number}。请询问用户需要修改的具体内容，然后：\n1. 使用用户的修改意见，执行 `gh pr review {number} --repo hs3180/disclaude --request-changes --body \"{用户意见}\"`\n2. 注意：不改变 scanner state（保持 reviewing），等待作者更新后重新触发",
    "close": "[用户操作] 用户关闭 PR #{number}。请执行：\n1. `gh pr close {number} --repo hs3180/disclaude`\n2. `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state closed`\n3. 报告执行结果"
  }
}
```

**注意**: `send_interactive` 不是 `send_card`。使用 `send_interactive` 以获得完整的 actionPrompt 支持。

### Step 6: 确认 Label 已添加（兜底）

Step 4 的 `create-state` 已自动添加 Label。但如果需要手动确认:

```bash
gh pr view {number} --repo hs3180/disclaude --json labels --jq '.labels[].name'
```

如果未包含 `pr-scanner:reviewing`，手动添加:
```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:reviewing"
```

## 状态管理

### State File Schema (`.temp-chats/pr-{number}.json`)

```json
{
  "prNumber": 123,
  "chatId": null,
  "state": "reviewing",
  "createdAt": "2026-04-07T10:00:00Z",
  "updatedAt": "2026-04-07T10:00:00Z",
  "expiresAt": "2026-04-09T10:00:00Z",
  "disbandRequested": null
}
```

### State Transitions

```
新 PR → create-state (reviewing) → [用户交互] → mark (approved/closed)
                                            ↑
                                    request_changes 不改变状态
```

### GitHub Label 映射

| State | Label | 操作 |
|-------|-------|------|
| `reviewing` | `pr-scanner:reviewing` (添加) | `create-state` 自动添加 |
| `approved` | `pr-scanner:reviewing` (移除) | `mark --state approved` 自动移除 |
| `closed` | `pr-scanner:reviewing` (移除) | `mark --state closed` 自动移除 |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `scanner.ts` 执行失败 | 记录错误，退出本次执行 |
| `gh pr view` 失败 | 记录错误，跳过该 PR |
| `send_interactive` 失败 | 回退到 `send_message` 发送纯文本通知 |
| Label 操作失败 | 不阻塞主流程（scanner.ts 已处理为 warn） |
| 并行容量满 | 退出本次执行，等待下次触发 |
| 无候选 PR | 正常退出，无需处理 |

## 不包含

- 讨论群生命周期管理（Issue #2221 / Phase 2）
- 文件锁（Issue #2222）
- 自动合并（所有操作需用户确认）

## 验收标准

- [ ] Schedule 可被 Scheduler 正常触发
- [ ] `scanner.ts` 输出 JSON 可被 AI Agent 解析
- [ ] `send_interactive` 卡片按钮可点击并触发正确 actionPrompt
- [ ] Label 正确添加/移除（`pr-scanner:reviewing`）
- [ ] 容量限制生效（max 3 reviewing）
- [ ] 错误路径有回退方案

## 关联

- Parent: #2210
- Depends on: #2219 (scanner.ts base, included in this PR)
- Related: #2221 (lifecycle management, Phase 2)
- Design: docs/designs/pr-scanner-design.md
