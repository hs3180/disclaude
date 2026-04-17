---
name: "PR Scanner v2"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-18T00:00:00.000Z
---

# PR Scanner v2 — SCHEDULE.md + GitHub Label 集成 + 通知流程

基于 scanner.ts 状态管理的 PR 扫描器：发现待审 PR → 创建状态文件 → 发送交互式卡片通知 → 等待用户决策。通过 GitHub Label 实现兜底可见性。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并行审查**: 3 个
- **状态目录**: `.temp-chats/`
- **审查超时**: 48 小时（由 scanner.ts `expiresAt` 管理）

## 前置依赖

- `scanner.ts`（PR Scanner CLI 脚本，Issue #2219 提供）
- `gh` CLI（GitHub CLI，用于 PR 操作和 Label 管理）
- MCP Tool: `send_interactive`（用于发送可点击的交互式卡片）

> **⚠️ Phase 1 说明**: Phase 1 不创建独立讨论群聊，直接在 admin chatId 中发送通知。群聊创建（Phase 2）由 `discussion-lifecycle` schedule 提供。

## 职责边界

- ✅ 扫描发现待审 PR
- ✅ 容量检查（max 3 reviewing）
- ✅ 创建状态文件 + 添加 GitHub Label
- ✅ 发送 PR 详情 + 操作卡片
- ✅ 处理用户决策（approve / request changes / close）
- ✅ 更新状态 + 移除 GitHub Label
- ❌ 不创建讨论群聊（Phase 2，由 discussion-lifecycle 负责）
- ❌ 不管理文件锁（Issue #2222 独立修复）
- ❌ 不处理非 pr-scanner:reviewing 状态的 PR

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx schedules/pr-scanner/scanner.ts --action check-capacity
```

解析 JSON 输出：
- `{"canAccept": true, "current": N, "max": 3}` — 继续 Step 2
- `{"canAccept": false, ...}` — **退出本次执行**，等待下次调度

### Step 2: 发现待审 PR

```bash
npx tsx schedules/pr-scanner/scanner.ts --action list-candidates
```

解析 JSON 输出：
- `{"candidates": [...]}` — 取第一个候选 PR，继续 Step 3
- `{"candidates": []}` — **退出本次执行**，无待审 PR

### Step 3: 获取 PR 详情

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

提取关键字段用于后续通知。

### Step 4: 创建状态文件

```bash
npx tsx schedules/pr-scanner/scanner.ts --action create-state --pr {number}
```

此操作是幂等的 — 重复执行不会创建重复状态文件。

### Step 5: 添加 GitHub Label（兜底可见性）

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:reviewing"
```

> **注意**: Label 操作失败**不阻塞主流程**。如果 `gh pr edit` 失败，记录警告并继续。

### Step 6: 发送 PR 详情 + 操作卡片

使用 `send_interactive` 工具发送交互式通知卡片：

**调用参数**:
```
tool: send_interactive
title: "📋 PR #{number} 等待审查"
question: |
  **{title}**

  | 属性 | 值 |
  |------|-----|
  | 👤 作者 | {author} |
  | 🌿 分支 | {headRef} → {baseRef} |
  | 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |
  | 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |

  **描述**: {body 前300字符}

options:
  - text: "✅ Approve", value: "approve", type: "primary"
  - text: "🔄 Request Changes", value: "request_changes", type: "default"
  - text: "❌ Close PR", value: "close", type: "danger"
chatId: {当前 schedule chatId}
actionPrompts:
  approve: "[用户操作] 用户批准合并 PR #{number}。请执行以下步骤：1. 运行 `gh pr review {number} --repo hs3180/disclaude --approve --body 'Approved via PR Scanner'` 2. 运行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state approved` 3. 运行 `gh pr edit {number} --repo hs3180/disclaude --remove-label 'pr-scanner:reviewing'` 4. 报告执行结果"
  request_changes: "[用户操作] 用户请求修改 PR #{number}。请询问用户需要修改的具体内容。获取反馈后：1. 运行 `gh pr review {number} --repo hs3180/disclaude --request-changes --body '{用户反馈}'` 2. 注意：不改变 scanner state，PR 仍保持 reviewing 状态"
  close: "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：1. 运行 `gh pr close {number} --repo hs3180/disclaude` 2. 运行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state closed` 3. 运行 `gh pr edit {number} --repo hs3180/disclaude --remove-label 'pr-scanner:reviewing'` 4. 报告执行结果"
```

> **⚠️ 关键**: 必须包含 `actionPrompts`，否则按钮仅为展示用途，无法点击。

### Step 7: 等待下次调度

本次执行完成。用户点击按钮后，actionPrompt 会触发新的 agent 响应来处理决策。

## 状态管理

### scanner.ts 状态文件

状态文件存储在 `.temp-chats/pr-{number}.json`，Schema 遵循设计规范 §3.1：

```json
{
  "prNumber": 1234,
  "state": "reviewing",
  "createdAt": "2026-04-18T00:00:00.000Z",
  "expiresAt": "2026-04-20T00:00:00.000Z",
  "disbandRequested": null
}
```

### 状态枚举

| 状态 | 含义 | 可转换到 |
|------|------|----------|
| `reviewing` | 正在审查中 | `approved`, `closed` |
| `approved` | 已批准（等待合并） | 终态 |
| `closed` | 已关闭 | 终态 |

> **注意**: 不存在 `rejected` 状态。不合意的 PR 应使用 `request_changes`（保持 reviewing）或 `close`。

### GitHub Label

| Label | 含义 | 添加时机 | 移除时机 |
|-------|------|----------|----------|
| `pr-scanner:reviewing` | 正在通过 scanner 审查 | `create-state` 时 | `mark` 离开 reviewing 时 |

### 状态转换

```
新 PR → [check-capacity] → [list-candidates] → [create-state: reviewing]
  → [add-label: pr-scanner:reviewing] → [send_interactive]
  → 用户点击按钮:
    ├── approve → [gh pr review --approve] + [mark: approved] + [remove-label]
    ├── request_changes → [gh pr review --request-changes] (保持 reviewing)
    └── close → [gh pr close] + [mark: closed] + [remove-label]
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| scanner.ts 执行失败 | 记录错误，退出本次执行，等待下次调度 |
| `gh pr view` 失败 | 记录错误，跳过该 PR，等待下次调度 |
| `send_interactive` 发送失败 | 记录错误，退出本次执行。状态文件已创建，下次调度不会重复处理 |
| `gh pr edit` (Label) 失败 | **忽略**，不阻塞主流程。Label 仅为兜底可见性 |
| `gh pr review` 失败 | 记录错误，报告给用户。不自动回滚 scanner state |
| `gh pr close` 失败 | 记录错误，报告给用户。不自动回滚 scanner state |
| 容量已满 (`canAccept: false`) | 正常退出，等待下次调度 |
| PR 已被手动处理 | scanner.ts `create-state` 是幂等的，`list-candidates` 会自动跳过已有状态文件的 PR |
| lark-cli 不可用 | Phase 1 不依赖 lark-cli，使用 admin chatId 发送通知 |

## 注意事项

1. **幂等性**: `create-state` 是幂等的，重复执行不会创建重复状态文件
2. **串行处理**: 一次只处理一个 PR（容量检查限制 max 3，但每次调度只推进一个）
3. **无状态**: Schedule 不维护内存状态，所有状态通过 scanner.ts 状态文件管理
4. **Label 兜底**: GitHub Label 仅为兜底可见性，不影响 scanner.ts 核心逻辑
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只通过 scanner.ts 管理 `.temp-chats/` 目录
7. **send_interactive 必须**: 使用 `send_interactive`（非 `send_card` 或 `send_message`）发送交互式卡片，确保按钮可点击
8. **actionPrompts 必须**: 必须包含 `actionPrompts`，否则按钮不可点击
9. **不使用 rejected**: 状态只有 `reviewing` | `approved` | `closed`，无 `rejected`
10. **Phase 1 回退**: 不创建讨论群聊，直接在 admin chatId 中通知

## 验收标准

- [ ] Schedule 可被 Scheduler 正常触发
- [ ] scanner.ts 输出 JSON 可被 AI Agent 正确解析
- [ ] `send_interactive` 卡片按钮可点击并触发正确 actionPrompt
- [ ] Label `pr-scanner:reviewing` 正确添加/移除
- [ ] 容量限制生效（max 3 reviewing）
- [ ] 错误路径有回退方案（Label 失败不阻塞，发送失败不影响状态）
- [ ] 一次只处理一个 PR（串行模式）
