---
name: "PR Scanner v2 (SCHEDULE)"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner v2 — Schedule Prompt

定期扫描仓库的 open PR，为符合条件的 PR 创建状态追踪并发送详情卡片。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并发**: 3 个 reviewing
- **讨论超时**: 48 小时

## 前置检查

确认环境可用：

```bash
gh auth status
npx tsx --version
```

如果 `gh auth status` 失败，退出本次执行并报告错误。

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx schedules/pr-scanner.ts --action check-capacity
```

解析输出 JSON：
- `available > 0` → 继续下一步
- `available === 0` → 输出 "PR Scanner: 已达最大并发数，跳过本次扫描" 并退出

### Step 2: 发现待审 PR

先获取所有 open PR 列表（排除已有 scanner 相关 label 的）：

```bash
gh pr list --repo hs3180/disclaude --state open \
  --json number,title,author,labels,updatedAt \
  --jq '.[] | select((.labels // [] | length) == 0 or (.labels | all(.name != "pr-scanner:reviewing"))) | {number, title, author: .author.login, labels: [.labels[].name], updatedAt}'
```

将输出通过 pipe 传入 scanner 过滤已追踪的 PR：

```bash
gh pr list --repo hs3180/disclaude --state open \
  --json number,title,author,labels \
  | npx tsx schedules/pr-scanner.ts --action list-candidates
```

如果输出为空数组 `[]`，输出 "PR Scanner: 无新 PR 需要处理" 并退出。

取**第一个** candidate PR 作为本次处理对象。

### Step 3: 获取 PR 详情

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles,url
```

提取关键字段：
- `title`: PR 标题
- `author.login`: 作者
- `headRefName` / `baseRefName`: 分支信息
- `mergeable`: 合并状态（MERGEABLE / CONFLICTING / UNKNOWN）
- `statusCheckRollup`: CI 状态
- `additions` / `deletions` / `changedFiles`: 变更统计
- `url`: PR 链接

### Step 4: 创建讨论群（Phase 2 实现，Phase 1 回退到 admin chatId）

**Phase 1（当前）**: 直接在当前 chatId 发送 PR 详情卡片。

**Phase 2（群创建可用后）**: 使用 lark-cli 创建独立讨论群：

```bash
lark-cli group create --topic "PR #{number} 讨论: {title前30字符}"
```

如果 lark-cli 不可用，回退到 admin chatId（当前 chatId）。

### Step 5: 写入状态文件 + 添加 Label

```bash
npx tsx schedules/pr-scanner.ts --action create-state --pr {number}
```

此操作会：
1. 在 `.temp-chats/pr-{number}.json` 创建状态文件（state=reviewing）
2. 自动为 PR 添加 `pr-scanner:reviewing` GitHub Label

确认状态文件创建成功后继续。如果报错 "already exists"，跳过此 PR。

### Step 6: 发送 PR 详情卡片

使用 `send_interactive` 发送 PR 详情 + 操作卡片。

**卡片内容**：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "📋 PR #{number}: {title前50字符}", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "| 属性 | 值 |\n|------|-----|\n| 👤 作者 | @{author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |\n\n### 📋 描述\n{body前300字符}\n\n---\n🔗 [查看 PR]({url})"},
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
  "approve_{number}": "[用户操作] 用户批准 PR #{number}。请执行以下步骤：\n1. 检查 CI 状态（statusCheckRollup）是否全部通过\n2. 如果 CI 通过，执行 `gh pr review {number} --repo hs3180/disclaude --approve --body 'Approved via PR Scanner v2'`\n3. 执行 `npx tsx schedules/pr-scanner.ts --action mark --pr {number} --state approved` 更新状态并移除 label\n4. 报告执行结果",
  "request_changes_{number}": "[用户操作] 用户请求修改 PR #{number}。请询问用户需要修改的具体内容，然后执行 `gh pr review {number} --repo hs3180/disclaude --request-changes --body '<用户输入的修改意见>'`。注意：不改变 PR state，保留 reviewing 状态。",
  "close_{number}": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. 执行 `gh pr close {number} --repo hs3180/disclaude`\n2. 执行 `npx tsx schedules/pr-scanner.ts --action mark --pr {number} --state closed` 更新状态并移除 label\n3. 报告执行结果"
}
```

### Step 7: 兜底 Label 确认

如果 Step 5 的 label 添加可能失败（网络问题等），手动确认：

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:reviewing"
```

仅当 PR 没有该 label 时执行。Label 操作失败不影响主流程。

## 状态管理

### Label 定义

| Label | 含义 |
|-------|------|
| `pr-scanner:reviewing` | 正在等待审核反馈 |

### 状态转换

```
新 PR → create-state (reviewing + label) → 发送卡片 → 等待用户操作
  → Approve → mark approved + remove label
  → Close → mark closed + remove label
  → Request Changes → 保持 reviewing（不改变 state）
```

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| `gh auth` 失败 | 退出执行，报告错误 |
| scanner.ts 执行失败 | 记录错误，跳过本次 |
| Label 添加失败 | 忽略，不阻塞主流程 |
| send_interactive 失败 | 状态文件已创建，下次不重复处理 |
| PR mergeable=UNKNOWN | 正常发送卡片，标注"合并状态未知" |

## 注意事项

1. **串行处理**: 每次只处理一个新 PR（取第一个 candidate）
2. **容量限制**: 最多 3 个 reviewing 状态的 PR 并行
3. **幂等性**: 重复执行不会重复创建状态文件
4. **Label 容错**: Label 操作始终 try-catch，失败不影响核心流程

## 依赖

- gh CLI（已认证）
- `schedules/pr-scanner.ts`（scanner 基础脚本）
- MCP Tool: `send_interactive`
- GitHub Label: `pr-scanner:reviewing`

## 关联

- Related: #2220
- Parent: #2210
- Depends on: #2219
