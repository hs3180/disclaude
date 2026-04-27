---
name: "PR Scanner v2"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner v2 — 定时 PR 审查扫描

定期扫描仓库的 open PR，为每个待审 PR 创建独立讨论群，发送交互式审查卡片，通过 GitHub Label 追踪审查状态。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并行审查数**: 3（`PR_MAX_CONCURRENT` 环境变量可覆盖）
- **审查过期时间**: 24 小时（`PR_EXPIRY_HOURS` 环境变量可覆盖）
- **状态文件目录**: `.temp-chats/`（`PR_STATE_DIR` 环境变量可覆盖）

## 前置依赖

- `gh` CLI（GitHub 官方 CLI，已认证）
- `npx tsx`（TypeScript 执行器）
- `schedules/pr-scanner/scanner.ts`（Sub-Issue A #2219 提供）
- GitHub Labels: `pr-scanner:reviewing`（需预先创建）

## 职责边界

- ✅ 扫描 open PR，按审查状态过滤
- ✅ 通过 GitHub Label 管理审查状态
- ✅ 创建讨论群并发送 PR 详情卡片
- ✅ 追踪审查状态（reviewing → approved/closed）
- ✅ 容量限制（最多同时审查 3 个 PR）
- ❌ 不自动合并 PR（由用户在群聊中决定）
- ❌ 不管理讨论群生命周期（Sub-Issue C #2221 负责）
- ❌ 不处理文件锁（Sub-Issue D #2222 负责）

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx schedules/pr-scanner/scanner.ts --action check-capacity
```

输出 JSON 示例:
```json
{"reviewing": 2, "maxConcurrent": 3, "available": 1}
```

如果 `available` 为 0，说明已达到并行上限，**终止本次执行**。

### Step 2: 发现待审 PR

```bash
npx tsx schedules/pr-scanner/scanner.ts --action list-candidates
```

输出 JSON 示例:
```json
[2891, 2888, 2887]
```

如果输出为空数组 `[]`，说明没有待审 PR，**终止本次执行**。

### Step 3: 获取 PR 详情

对 `list-candidates` 返回的每个 PR 编号（在容量限制内），获取详细信息：

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json number,title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles,labels,createdAt,updatedAt
```

解析以下字段：
- `number` — PR 编号
- `title` — 标题
- `body` — 描述（截取前 500 字符用于卡片展示）
- `author.login` — 作者
- `headRefName` — 源分支
- `baseRefName` — 目标分支
- `mergeable` — 是否可合并
- `statusCheckRollup` — CI 状态
- `additions` / `deletions` / `changedFiles` — 变更统计
- `labels[].name` — 已有 Label

### Step 4: 创建讨论群

> **注意**: Phase 1 先回退到使用 `send_interactive` 发送到固定 chatId。Phase 2（Sub-Issue C #2221）实现后切换为 `start_group_discussion` 工具创建独立讨论群。

**Phase 1（当前）**: 跳过群创建，使用 Step 6 的卡片直接发送到 admin chatId。

**Phase 2（#2221 合并后）**: 使用 `start_group_discussion` 工具：

```json
{
  "topic": "PR #{number} 审查: {title}",
  "members": [],
  "context": "## PR #{number}: {title}\n\n| 属性 | 值 |\n|------|-----|\n| 作者 | {author} |\n| 分支 | {headRef} → {baseRef} |\n| 合并状态 | {mergeable} |\n| CI 检查 | {ciStatus} |\n| 变更 | +{additions} -{deletions} ({changedFiles} files) |\n\n{description}",
  "timeout": 60
}
```

### Step 5: 写入审查状态

```bash
npx tsx schedules/pr-scanner/scanner.ts --action create-state --pr {number}
```

这会在 `.temp-chats/pr-{number}.json` 创建状态文件，状态为 `reviewing`。

### Step 6: 发送 PR 详情卡片

使用 `send_interactive`（非 `send_card`）发送交互式审查卡片。

**卡片 JSON**:
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "🔍 PR #{number}: {title_前50字符}", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "| 属性 | 值 |\n|------|-----|\n| 👤 作者 | @{author} |\n| 🌿 分支 | `{headRef}` → `{baseRef}` |\n| 📊 合并 | {mergeable_status} |\n| 🔍 CI | {ci_status} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |\n| 🕐 创建 | {createdAt} |"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "**📋 描述摘要**\n\n{body_前300字符}"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve-{number}", "type": "primary"},
      {"tag": "button", "text": {"content": "❌ Request Changes", "tag": "plain_text"}, "value": "request-changes-{number}", "type": "danger"},
      {"tag": "button", "text": {"content": "🔄 Close", "tag": "plain_text"}, "value": "close-{number}"},
      {"tag": "button", "text": {"content": "🔗 Open PR", "tag": "plain_text"}, "url": {"url": "https://github.com/hs3180/disclaude/pull/{number}", "pc_url": "https://github.com/hs3180/disclaude/pull/{number}"}, "type": "default", "multi_url": true}
    ]},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "请在群聊中讨论后选择操作。卡片按钮点击后会触发对应的审查流程。"}
    ]}
  ]
}
```

**actionPrompts**:
```json
{
  "approve-{number}": "[用户操作] 用户批准了 PR #{number}。请执行以下步骤：\n1. 执行 `gh pr review {number} --repo hs3180/disclaude --approve --body 'LGTM :ship:'`\n2. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state approved`\n3. 执行 `gh pr edit {number} --repo hs3180/disclaude --remove-label 'pr-scanner:reviewing'`\n4. 发送确认消息：'✅ PR #{number} 已批准'",
  "request-changes-{number}": "[用户操作] 用户请求修改 PR #{number}。请执行以下步骤：\n1. 询问用户具体的修改意见\n2. 执行 `gh pr review {number} --repo hs3180/disclaude --request-changes --body '{用户意见}'`\n3. 发送确认消息：'❌ PR #{number} 已请求修改'\n注意：不改变审查状态，PR 仍为 reviewing",
  "close-{number}": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. 执行 `gh pr close {number} --repo hs3180/disclaude`\n2. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state closed`\n3. 执行 `gh pr edit {number} --repo hs3180/disclaude --remove-label 'pr-scanner:reviewing'`\n4. 发送确认消息：'🔄 PR #{number} 已关闭'"
}
```

### Step 7: 添加 reviewing Label

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:reviewing"
```

> **注意**: 如果 Label `pr-scanner:reviewing` 不存在，先创建：
> ```bash
> gh label create "pr-scanner:reviewing" --repo hs3180/disclaude --description "PR is under review by scanner" --color "1D76DB" --force 2>/dev/null || true
> ```

Label 操作失败不阻塞主流程（仅记录警告）。

## GitHub Label 管理

### Label 定义

| Label | 含义 | 颜色 | 添加时机 | 移除时机 |
|-------|------|------|----------|----------|
| `pr-scanner:reviewing` | 正在审查中 | `1D76DB` (蓝) | create-state 后 | mark approved/closed 后 |

### 状态转换

```
新 PR (无 Label)
  ↓ list-candidates 发现
  ↓ create-state + add-label
reviewing (pr-scanner:reviewing)
  ↓ 用户 Approve
  ↓ mark approved + remove-label
approved (无 Label, 状态文件 state=approved)
  ↓ 用户 Request Changes
  ↓ (不变，仍为 reviewing)
reviewing (不变)
  ↓ 用户 Close
  ↓ mark closed + remove-label
closed (无 Label, 状态文件 state=closed)
```

### Label 操作规则

1. **create-state 时**: 添加 `pr-scanner:reviewing` label
2. **mark approved 时**: 移除 `pr-scanner:reviewing` label
3. **mark closed 时**: 移除 `pr-scanner:reviewing` label
4. **request-changes 时**: 不改变 label（PR 仍在审查中）
5. **Label 失败**: 记录警告，不阻塞主流程

## 错误处理

| 场景 | 处理方式 | 是否阻塞 |
|------|----------|----------|
| `gh` CLI 未安装或未认证 | 终止执行，发送错误通知 | ✅ 阻塞 |
| `scanner.ts` 执行失败 | 记录错误，跳过该 PR | ❌ 不阻塞 |
| `check-capacity` 返回 0 | 正常终止，无待处理 | ✅ 终止（正常） |
| `list-candidates` 返回空 | 正常终止，无待审 PR | ✅ 终止（正常） |
| `gh pr view` 失败 | 记录错误，跳过该 PR | ❌ 不阻塞 |
| `create-state` 失败 | 记录错误，跳过该 PR | ❌ 不阻塞 |
| `send_interactive` 失败 | 回退到 `send_message`（纯文本） | ❌ 不阻塞 |
| `gh pr edit --add-label` 失败 | 记录警告，继续流程 | ❌ 不阻塞 |
| `gh pr edit --remove-label` 失败 | 记录警告，继续流程 | ❌ 不阻塞 |
| Label 不存在 | 自动创建（`--force`），失败则忽略 | ❌ 不阻塞 |
| `start_group_discussion` 不可用 | 回退到 admin chatId | ❌ 不阻塞 |

## 注意事项

1. **串行处理**: 在容量限制内，逐个处理每个待审 PR
2. **无状态设计**: 所有状态通过 GitHub Label + `.temp-chats/` 状态文件管理
3. **幂等性**: 重复执行不会产生副作用（scanner.ts 的 create-state 会检查重复）
4. **不创建新 Schedule**: 这是定时任务执行环境的规则
5. **不修改其他文件**: 只操作 `.temp-chats/` 目录和 GitHub Labels
6. **容量限制**: 最多同时审查 3 个 PR，避免用户不堪重负
7. **Phase 1 限制**: 当前版本使用 admin chatId 发送卡片，不创建独立讨论群
8. **Label 兜底**: 所有 Label 操作失败不阻塞，确保核心流程可用

## 验收标准

- [ ] Schedule 可被 Scheduler 正常触发
- [ ] scanner.ts 输出 JSON 可被 AI Agent 正确解析
- [ ] `send_interactive` 卡片按钮可点击并触发正确 actionPrompt
- [ ] `pr-scanner:reviewing` Label 正确添加（create-state 后）
- [ ] `pr-scanner:reviewing` Label 正确移除（mark approved/closed 后）
- [ ] 容量限制生效（max 3 reviewing）
- [ ] 错误路径有回退方案（Label 失败不阻塞）
- [ ] Phase 1 回退到 admin chatId（群创建不可用时）

## 关联

- Parent: #2210
- Depends on: #2219 (scanner.ts)
- Phase 2: #2221 (讨论群生命周期管理)
- File lock fix: #2222
