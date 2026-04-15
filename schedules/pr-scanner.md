---
name: "PR Scanner v2"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner v2 — 状态驱动的 PR 审查调度

定期扫描仓库的 open PR，通过 `scanner.ts` 管理审查状态，为每个 PR 发送交互式审查卡片。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并行审查**: 3 个（`PR_SCANNER_MAX_CONCURRENT` 环境变量可覆盖）
- **状态超时**: 48 小时（`PR_SCANNER_EXPIRY_HOURS` 环境变量可覆盖）

## 前置依赖

- `gh` CLI（GitHub 官方命令行工具）
- `npx tsx`（用于运行 scanner.ts）
- GitHub Label: `pr-scanner:reviewing`

## 职责边界

- ✅ 检查并行审查容量
- ✅ 发现未跟踪的 open PR
- ✅ 为新 PR 创建状态文件并添加 reviewing label
- ✅ 发送 PR 详情和交互式操作卡片
- ❌ 不自动合并或关闭 PR（由用户通过卡片操作决定）
- ❌ 不管理讨论群生命周期（Phase C / Sub-Issue #2221）
- ❌ 不执行文件锁操作（Sub-Issue D）

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx skills/pr-scanner/scanner.ts --action check-capacity
```

解析输出 JSON：`{ "reviewing": N, "maxConcurrent": 3, "available": M }`

**如果 `available === 0`**，说明已达到最大并行审查数，**退出本次执行**。

### Step 2: 发现未跟踪的 PR

```bash
npx tsx skills/pr-scanner/scanner.ts --action list-candidates
```

这会列出所有已跟踪的 PR 状态文件。同时获取 GitHub 上的 open PR 列表：

```bash
gh pr list --repo hs3180/disclaude --state open \
  --json number,title,author,labels,updatedAt
```

**过滤规则** — 排除以下 PR：
- 已有 `pr-scanner:reviewing` label 的 PR（正在审查中）
- 已在 `list-candidates` 结果中且状态为 `closed` 的 PR（已完成）
- 草稿 PR（`isDraft: true`）

取过滤后的**第一个** PR 作为处理对象。如果没有未跟踪的 PR，**退出本次执行**。

### Step 3: 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles,labels
```

### Step 4: 创建状态文件 + 添加 Label

```bash
npx tsx skills/pr-scanner/scanner.ts --action create-state --pr {number}
```

此命令会：
1. 创建 `.temp-chats/pr-{number}.json` 状态文件
2. 通过 `gh pr edit` 添加 `pr-scanner:reviewing` label（非阻塞，失败仅记录警告）

如果创建失败（状态文件已存在），说明已被其他实例处理，**跳过此 PR**。

### Step 5: 发送 PR 详情 + 交互式卡片

使用 `send_interactive`（**非** `send_card`）发送 PR 详情和操作选项：

**消息内容**（format: "card"）：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "🔍 PR #{number} 需要审查", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "**{title}**\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |"},
    {"tag": "markdown", "content": "### 📋 描述\n{description 前500字符}\n\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve_{number}", "type": "primary"},
      {"tag": "button", "text": {"content": "❌ Request Changes", "tag": "plain_text"}, "value": "request_changes_{number}"},
      {"tag": "button", "text": {"content": "🔄 Close PR", "tag": "plain_text"}, "value": "close_{number}"}
    ]}
  ]
}
```

**actionPrompts**：
```json
{
  "approve_{number}": "[用户操作] 用户批准 PR #{number}。请执行以下步骤：\n1. 检查 CI 状态是否通过\n2. 执行 `gh pr review {number} --repo hs3180/disclaude --approve`\n3. 执行 `npx tsx skills/pr-scanner/scanner.ts --action mark --pr {number} --state approved` 更新状态\n4. 报告执行结果",
  "request_changes_{number}": "[用户操作] 用户请求修改 PR #{number}。请：\n1. 询问用户需要修改的具体内容\n2. 使用 `gh pr review {number} --repo hs3180/disclaude --request-changes -b \"{用户输入的修改意见}\"` 提交审查意见\n3. 注意：不改变 scanner 状态，PR 仍为 reviewing",
  "close_{number}": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. 执行 `gh pr close {number} --repo hs3180/disclaude`\n2. 执行 `npx tsx skills/pr-scanner/scanner.ts --action mark --pr {number} --state closed` 更新状态\n3. 报告执行结果"
}
```

> **⚠️ 重要**: 按钮的 `value` 必须包含 PR 编号（如 `approve_123`），`actionPrompts` 的 key 和 prompt 中也必须使用相同的 PR 编号。Schedule 执行时，用实际的 PR 编号替换 `{number}` 占位符。

### Step 6: 验证 Label 兜底

检查 label 是否已添加（`scanner.ts` 的 `create-state` 已自动处理，此步为兜底验证）：

```bash
gh pr view {number} --repo hs3180/disclaude --json labels --jq '.labels[].name'
```

如果输出中不包含 `pr-scanner:reviewing`，手动添加：
```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:reviewing"
```

## 状态管理

### Label 定义

| Label | 含义 |
|-------|------|
| `pr-scanner:reviewing` | 正在被 scanner 跟踪审查中 |

### 状态文件（`.temp-chats/pr-{number}.json`）

```json
{
  "prNumber": 123,
  "chatId": null,
  "state": "reviewing",
  "createdAt": "2026-04-15T10:00:00Z",
  "updatedAt": "2026-04-15T10:00:00Z",
  "expiresAt": "2026-04-17T10:00:00Z",
  "disbandRequested": null
}
```

### 状态转换

```
新 PR → create-state (reviewing + label) → 用户操作:
  ├─ approve → mark approved (自动移除 label)
  └─ close   → mark closed  (自动移除 label)
```

| 操作 | scanner.ts action | Label 变化 |
|------|-------------------|------------|
| 发现新 PR | `create-state --pr N` | ➕ 添加 `pr-scanner:reviewing` |
| 用户 Approve | `mark --pr N --state approved` | ➖ 移除 `pr-scanner:reviewing` |
| 用户 Close | `mark --pr N --state closed` | ➖ 移除 `pr-scanner:reviewing` |
| 用户 Request Changes | 无状态变更 | 🔒 保持 `pr-scanner:reviewing` |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| scanner.ts 执行失败 | 记录错误，跳过此 PR，继续处理下一个 |
| gh CLI 失败（获取 PR 列表） | 记录错误，退出本次执行 |
| gh CLI 失败（获取 PR 详情） | 跳过此 PR |
| Label 添加失败 | 不阻塞主流程（scanner.ts 内部已处理） |
| Label 移除失败 | 不阻塞主流程（scanner.ts 内部已处理） |
| send_interactive 发送失败 | 回退到在 admin chatId 发送纯文本通知 |

## 验证标准

- [ ] Schedule 可被 Scheduler 正常触发
- [ ] scanner.ts `check-capacity` 输出 JSON 可被解析
- [ ] scanner.ts `list-candidates` 输出 JSON 可被解析
- [ ] scanner.ts `create-state` 正确创建状态文件
- [ ] `send_interactive` 卡片按钮可点击并触发正确 actionPrompt
- [ ] `pr-scanner:reviewing` Label 正确添加/移除
- [ ] 容量限制生效（max 3 reviewing）
- [ ] 错误路径有回退方案

## 不包含

- 讨论群生命周期管理（Sub-Issue C / Phase 2 / #2221）
- 文件锁（Sub-Issue D）
- 群聊创建（lark-cli，Phase 2 实现，当前使用 admin chatId）

## 关联

- Parent: #2210
- Depends on: #2219 (scanner.ts 骨架)
- Next: #2221 (讨论群生命周期管理)
- Design: `docs/designs/pr-scanner-design.md`
