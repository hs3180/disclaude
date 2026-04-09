---
name: "PR Scanner (v2)"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner v2 — 定时扫描 + 交互审查

定期扫描仓库的 open PR，发现未审查的 PR 后发送交互卡片，支持 Approve / Request Changes / Close 操作。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并行审查**: 3 个（`PR_SCANNER_MAX_REVIEWING` 环境变量可覆盖）
- **状态目录**: `.temp-chats/`（`PR_SCANNER_STATE_DIR` 环境变量可覆盖）
- **过期时间**: 48 小时

## 前置依赖

- `gh` CLI（已认证，有 repo 权限）
- `npx tsx`（运行 scanner.ts）
- GitHub Label: `pr-scanner:reviewing`（需预先创建）

## 职责边界

- ✅ 发现未审查的 open PR
- ✅ 发送 PR 详情交互卡片（Approve / Request Changes / Close）
- ✅ 管理 GitHub Label（`pr-scanner:reviewing`）
- ✅ 管理状态文件（`.temp-chats/pr-{number}.json`）
- ❌ 不创建讨论群（Phase 2，回退到 admin chatId）
- ❌ 不处理文件锁（Sub-Issue D）
- ❌ 不处理已关闭或已合并的 PR

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx scripts/schedule/pr-scanner.ts --action check-capacity
```

解析 JSON 输出：
```json
{"reviewing": 1, "maxConcurrent": 3, "available": 2}
```

**判断**: 如果 `available === 0`，跳过本次扫描，输出「容量已满，跳过」。

### Step 2: 发现待审 PR

```bash
npx tsx scripts/schedule/pr-scanner.ts --action list-candidates
```

解析 JSON 输出（数组，按 updatedAt 升序排列）：
```json
[{"number": 1234, "title": "feat: ...", "author": "user", "labels": [], "updatedAt": "..."}]
```

**判断**: 如果数组为空，跳过本次扫描，输出「无待审 PR」。

**注意**: 只处理第一个候选 PR（串行处理，避免并发问题）。如果 `available > 1`，可以处理多个，但最多 `available` 个。

### Step 3: 获取 PR 详情

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

提取关键信息：
- 标题、作者、分支（head → base）
- 合并状态（mergeable）
- CI 检查状态（statusCheckRollup）
- 变更统计（+additions -deletions, changedFiles files）

### Step 4: 创建状态文件

```bash
npx tsx scripts/schedule/pr-scanner.ts --action create-state --pr {number}
```

这会：
1. 创建 `.temp-chats/pr-{number}.json` 状态文件（state: reviewing）
2. 自动添加 `pr-scanner:reviewing` GitHub Label（非阻塞，失败不影响主流程）

解析输出中的状态文件 JSON。

### Step 5: 发送交互卡片

使用 `send_interactive` 发送 PR 详情和操作选项（**Phase 1 固定发到 admin chatId**）：

**卡片内容**：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "📋 PR #{number} 等待审查", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "**{title}**\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 🔍 CI 检查 | {ciStatus} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |"},
    {"tag": "markdown", "content": "---\n### 📋 描述\n{body 前500字符}"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve", "type": "primary"},
      {"tag": "button", "text": {"content": "❌ Request Changes", "tag": "plain_text"}, "value": "request_changes"},
      {"tag": "button", "text": {"content": "🔄 Close PR", "tag": "plain_text"}, "value": "close"}
    ]}
  ]
}
```

**actionPrompts**：
```json
{
  "approve": "[用户操作] 用户批准 PR #{number}。请执行：\n1. 运行 `gh pr review {number} --repo hs3180/disclaude --approve --body \"Approved via PR Scanner\"`\n2. 运行 `npx tsx scripts/schedule/pr-scanner.ts --action mark --pr {number} --state approved`\n3. 报告执行结果",
  "request_changes": "[用户操作] 用户请求修改 PR #{number}。请：\n1. 询问用户需要修改的具体内容\n2. 收集反馈后运行 `gh pr review {number} --repo hs3180/disclaude --request-changes --body \"{用户反馈}\"`\n3. 注意：不改变 state（仍为 reviewing），等待作者更新后重新审查",
  "close": "[用户操作] 用户关闭 PR #{number}。请执行：\n1. 运行 `gh pr close {number} --repo hs3180/disclaude`\n2. 运行 `npx tsx scripts/schedule/pr-scanner.ts --action mark --pr {number} --state closed`\n3. 报告执行结果"
}
```

### Step 6: 兜底（可选）

如果 Step 5 失败，尝试手动添加 Label：

```bash
npx tsx scripts/schedule/pr-scanner.ts --action add-label --pr {number} --label pr-scanner:reviewing
```

## 状态管理

### 状态文件格式 (`.temp-chats/pr-{number}.json`)

```json
{
  "prNumber": 1234,
  "chatId": null,
  "state": "reviewing",
  "createdAt": "2026-04-10T12:00:00.000Z",
  "updatedAt": "2026-04-10T12:00:00.000Z",
  "expiresAt": "2026-04-12T12:00:00.000Z",
  "disbandRequested": null
}
```

### 状态转换

| 当前状态 | 用户操作 | 执行动作 | 新状态 | Label 操作 |
|----------|----------|----------|--------|------------|
| (无) | 发现新 PR | 创建状态 + 发卡片 | `reviewing` | 添加 `pr-scanner:reviewing` |
| `reviewing` | Approve | `gh pr review --approve` + mark | `approved` | 移除 `pr-scanner:reviewing` |
| `reviewing` | Close | `gh pr close` + mark | `closed` | 移除 `pr-scanner:reviewing` |
| `reviewing` | Request Changes | `gh pr review --request-changes` | `reviewing` | 无变化 |

### Label 管理

| Label | 含义 | 添加时机 | 移除时机 |
|-------|------|----------|----------|
| `pr-scanner:reviewing` | 正在通过 scanner 审查 | `create-state` 时自动添加 | `mark` 离开 reviewing 时自动移除 |

**重要**: Label 操作失败**不阻塞**主流程。`create-state` 和 `mark` 会自动处理 Label。

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 容量已满 | 跳过本次扫描 |
| 无待审 PR | 正常退出 |
| `gh pr view` 失败 | 记录错误，跳过该 PR |
| 状态文件已存在 | `create-state` 报错退出 |
| Label 操作失败 | 记录警告，不影响主流程 |
| `send_interactive` 失败 | 状态文件已创建，下次可手动处理 |

## 注意事项

1. **串行处理**: 每次扫描最多处理 `available` 个 PR
2. **幂等性**: `create-state` 拒绝重复文件，`mark` 可重复执行
3. **无状态**: Schedule 不维护内存状态，所有状态从文件和 gh CLI 读取
4. **非阻塞 Label**: Label 操作失败只记录警告，不影响核心流程
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只操作 `.temp-chats/pr-*.json` 状态文件

## 验收标准

- [ ] Schedule 可被 Scheduler 正常触发
- [ ] scanner.ts 输出 JSON 可被 AI Agent 解析
- [ ] `send_interactive` 卡片按钮可点击并触发正确 actionPrompt
- [ ] `pr-scanner:reviewing` Label 正确添加（create-state 时）
- [ ] `pr-scanner:reviewing` Label 正确移除（mark 离开 reviewing 时）
- [ ] Label 操作失败不阻塞主流程
- [ ] 容量限制生效（max 3 reviewing）
- [ ] 错误路径有回退方案

## 不包含

- 讨论群创建和生命周期管理（Sub-Issue C / Phase 2）
- 文件锁（Sub-Issue D）

## 关联

- Parent: #2210
- Depends on: #2219 (scanner.ts base — included in this implementation)
- Design: docs/designs/pr-scanner-design.md
