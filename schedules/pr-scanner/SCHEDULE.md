---
name: "PR Scanner (v2)"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner v2 — Schedule Prompt

定期扫描仓库的 open PR，通过 scanner.ts 管理状态，发送交互式卡片供用户审阅。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并行审阅**: 3 个 PR
- **审阅超时**: 48 小时（state file expiresAt）
- **脚本路径**: `schedules/pr-scanner/scanner.ts`

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx schedules/pr-scanner/scanner.ts --action check-capacity
```

解析输出 JSON：
```json
{ "reviewing": 1, "maxConcurrent": 3, "available": 2 }
```

如果 `available === 0`，**退出本次执行**（容量已满）。

### Step 2: 获取候选 PR 列表

```bash
npx tsx schedules/pr-scanner/scanner.ts --action list-candidates
```

解析输出 JSON（候选 PR 列表）：
```json
[
  { "number": 123, "title": "feat: some feature" },
  { "number": 456, "title": "fix: some bug" }
]
```

如果列表为空 `[]`，**退出本次执行**（无新 PR）。

### Step 3: 选择第一个候选 PR 并获取详情

取列表中的第一个 PR，获取详细信息：

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles,url
```

### Step 4: 发送 PR 详情到管理员 chatId

由于 Phase 1 不支持 lark-cli 群创建，直接使用 `send_interactive` 发送到 admin chatId。

使用 `send_interactive` 发送交互式卡片：

```json
{
  "chatId": "oc_71e5f41a029f3a120988b7ecb76df314",
  "title": "🔍 PR #{number}: {title}",
  "question": "## PR 详情\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |\n\n### 📋 描述\n{body 前 500 字符}\n\n🔗 [查看 PR]({url})",
  "options": [
    { "text": "✅ Approve", "value": "approve", "type": "primary" },
    { "text": "❌ Request Changes", "value": "request_changes", "type": "danger" },
    { "text": "🔄 Close PR", "value": "close", "type": "default" }
  ],
  "actionPrompts": {
    "approve": "[用户操作] 用户批准 PR #{number}。请执行以下步骤：\n1. 检查 CI 状态是否通过\n2. 执行 `gh pr review {number} --repo hs3180/disclaude --approve`\n3. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state approved`\n4. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action remove-label --pr {number}`\n5. 报告执行结果",
    "request_changes": "[用户操作] 用户请求修改 PR #{number}。请询问用户需要修改的具体内容，然后执行：\n1. 获取用户输入的修改意见\n2. 执行 `gh pr review {number} --repo hs3180/disclaude --request-changes -b \"{修改意见}\"`\n3. 报告执行结果\n注意：不改变 PR 的 scanner state，下次扫描会重新处理",
    "close": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. 执行 `gh pr close {number} --repo hs3180/disclaude`\n2. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state closed`\n3. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action remove-label --pr {number}`\n4. 报告执行结果"
  }
}
```

### Step 5: 创建状态文件

```bash
npx tsx schedules/pr-scanner/scanner.ts --action create-state --pr {number}
```

### Step 6: 添加 GitHub Label（兜底标记）

```bash
npx tsx schedules/pr-scanner/scanner.ts --action add-label --pr {number}
```

此步骤失败不影响主流程（label 是兜底机制）。

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| scanner.ts 执行失败 | 记录错误，退出本次执行 |
| `gh pr view` 失败 | 记录错误，跳过该 PR |
| `send_interactive` 失败 | 回退使用 `send_message` 发送纯文本通知 |
| Label 操作失败 | 忽略，不阻塞主流程（scanner.ts 内部已处理） |
| lark-cli 不可用（Phase 1） | 使用 admin chatId 发送 |

## 注意事项

1. **一次一个 PR**: 每次执行只处理一个 PR（串行模式）
2. **容量限制**: 最多 3 个并行 reviewing 状态的 PR
3. **幂等性**: `create-state` 对已存在的 state file 会报错，不会重复创建
4. **Label 兜底**: Label 操作失败不影响主流程
5. **Phase 1 回退**: 不使用 lark-cli 创建群聊，直接在 admin chatId 中发送

## 依赖

- `npx tsx` — 运行 scanner.ts
- `gh` CLI — GitHub PR 操作
- `send_interactive` MCP 工具 — 发送交互式卡片
- `send_message` MCP 工具 — 备用纯文本通知

## 相关

- Issue #2220 (本 Schedule)
- Issue #2219 (scanner.ts 基础骨架)
- Issue #2210 (PR Scanner v2 父 Issue)
