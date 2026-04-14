---
name: "PR Scanner v2"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-14T00:00:00.000Z
---

# PR Scanner v2 — Schedule Prompt

定期扫描仓库的 open PR，使用 scanner.ts 管理状态，通过 send_interactive 发送 PR 详情卡片。

## 配置

- **仓库**: hs3180/disclaude
- **状态目录**: `.temp-chats/`（scanner.ts 管理）
- **扫描间隔**: 每 15 分钟
- **最大并行**: 3 个 reviewing PR
- **过期时间**: 48 小时
- **GitHub Label**: `pr-scanner:reviewing`

## 前置依赖

- `gh` CLI（GitHub 操作）
- `npx tsx`（运行 scanner.ts）
- `skills/pr-scanner/scanner.ts`（#2219 提供的状态管理 CLI）

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx skills/pr-scanner/scanner.ts --action check-capacity
```

解析 JSON 输出：
- `available > 0` → 继续
- `available === 0` → **退出本次执行**（已达上限）

### Step 2: 获取候选 PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open \
  --json number,title,author,labels,updatedAt
```

将结果通过环境变量传入 scanner.ts 过滤已跟踪的 PR：

```bash
PR_SCANNER_CANDIDATES='<上面 gh pr list 的 JSON 输出>' \
  npx tsx skills/pr-scanner/scanner.ts --action list-candidates
```

如果返回空数组 `[]`，**退出本次执行**（无新 PR 需要处理）。

取返回的第一个 PR 作为本轮处理对象。

### Step 3: 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

### Step 4: 通知目标

**Phase 1（当前）**: 使用 admin chatId 发送。
**Phase 2**: 使用 lark-cli 创建讨论群（依赖 #2221）。

Phase 1 直接在固定 chatId 发送卡片。

### Step 5: 创建状态文件

```bash
npx tsx skills/pr-scanner/scanner.ts --action create-state \
  --pr {number} --chatId {chatId} \
  --repo hs3180/disclaude
```

> 注意：`--repo` 参数会让 scanner.ts 自动添加 `pr-scanner:reviewing` label。

如果返回错误（state file already exists），说明已被其他实例处理，**跳过**。

### Step 6: 发送 PR 详情交互卡片

使用 `send_interactive`（非 `send_card`）发送 PR 详情 + 操作按钮：

**chatId**: `oc_71e5f41a029f3a120988b7ecb76df314`（当前 admin chatId）

**format**: `"card"`

**content**（卡片 JSON）:
```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"content": "🔔 PR #{number} 待审核", "tag": "plain_text"},
    "template": "blue"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "**{title}**\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 🔍 CI 检查 | {ciStatus} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |"
    },
    {"tag": "hr"},
    {
      "tag": "markdown",
      "content": "### 📋 描述\n{description 前300字符}\n\n---\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})"
    },
    {"tag": "hr"},
    {
      "tag": "action",
      "actions": [
        {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve", "type": "primary"},
        {"tag": "button", "text": {"content": "❌ Request Changes", "tag": "plain_text"}, "value": "request_changes"},
        {"tag": "button", "text": {"content": "🔄 Close", "tag": "plain_text"}, "value": "close"}
      ]
    }
  ]
}
```

**actionPrompts**:
```json
{
  "approve": "[用户操作] 用户批准 PR #{number}。请执行：1. `gh pr review {number} --repo hs3180/disclaude --approve` 2. `npx tsx skills/pr-scanner/scanner.ts --action mark --pr {number} --state approved --repo hs3180/disclaude` 3. 报告结果",
  "request_changes": "[用户操作] 用户请求修改 PR #{number}。请询问用户需要修改的具体内容，然后用 `gh pr review {number} --repo hs3180/disclaude --request-changes -b '评论内容'` 添加评论。不改变 state。",
  "close": "[用户操作] 用户关闭 PR #{number}。请执行：1. `gh pr close {number} --repo hs3180/disclaude` 2. `npx tsx skills/pr-scanner/scanner.ts --action mark --pr {number} --state closed --repo hs3180/disclaude` 3. 报告结果"
}
```

> ⚠️ **重要**: `approve` 和 `close` 操作中包含 `scanner.ts --action mark`，mark 离开 reviewing 状态时会自动移除 `pr-scanner:reviewing` label（因为传了 --repo）。

### Step 7: 兜底 Label（如果 Step 5 未传 --repo）

如果 Step 5 因任何原因未自动添加 label，手动补充：

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:reviewing"
```

> 正常流程中 Step 5 的 `--repo` 会自动完成此步骤，此处仅为兜底。

## 状态管理

### 状态文件

| 字段 | 含义 |
|------|------|
| `pr-{number}.json` | scanner.ts 管理的状态文件，位于 `.temp-chats/` |
| `state` | `reviewing` → `approved` / `closed` |
| `expiresAt` | 创建时间 + 48h，过期由 chat-timeout schedule 处理 |

### GitHub Label

| Label | 含义 |
|-------|------|
| `pr-scanner:reviewing` | scanner.ts 在 create-state 时添加，mark 离开 reviewing 时移除 |

### 状态转换

```
新 PR → scanner.ts create-state (+label) → send_interactive 卡片 → 用户操作 →
  ├─ Approve → gh pr review --approve + scanner.ts mark approved (-label)
  ├─ Request Changes → gh pr review --request-changes (state 不变)
  └─ Close → gh pr close + scanner.ts mark closed (-label)
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `gh` 命令失败 | 记录错误，跳过当前 PR |
| scanner.ts 失败 | 记录错误，继续（state file 不存在时跳过） |
| Label 添加失败 | scanner.ts 内部记录 WARN，不阻塞主流程 |
| Label 移除失败 | scanner.ts 内部记录 WARN，不阻塞主流程 |
| lark-cli 不可用 | Phase 1 不使用 lark-cli，直接在 admin chatId 发送 |
| 容量已满 | 退出本次执行，等待下次调度 |
| 无候选 PR | 退出本次执行 |

## 注意事项

1. **有限并行**: 最多 3 个 reviewing PR（由 scanner.ts check-capacity 控制）
2. **幂等性**: create-state 在 state file 已存在时返回错误并跳过
3. **48h 过期**: 状态文件自动过期，过期处理由 chat-timeout schedule 负责（#2221 Phase 2）
4. **Label 失败不阻塞**: gh CLI label 操作失败只记录警告
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只操作 `.temp-chats/pr-*.json` 和 GitHub Labels

## 验收标准

- [ ] Schedule 可被 Scheduler 正常触发
- [ ] scanner.ts 输出 JSON 可被 AI Agent 解析
- [ ] `send_interactive` 卡片按钮可点击并触发正确 actionPrompt
- [ ] Label 正确添加/移除（`pr-scanner:reviewing`）
- [ ] 容量限制生效（max 3 reviewing）
- [ ] 错误路径有回退方案

## 关联

- Parent: #2210
- Depends on: #2219 (scanner.ts — PR #2324)
- Design: pr-scanner-v2-design.md §3.2, §3.4
- Related: #2221 (讨论群生命周期 — Phase 2)
