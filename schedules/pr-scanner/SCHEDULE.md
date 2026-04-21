---
name: "PR Scanner v2"
cron: "0 */30 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner v2 — Schedule Prompt

定期扫描仓库的 open PR，使用 scanner.ts 管理状态，通过 `send_interactive` 发送 PR 详情卡片。

> **Phase 1**: 使用 admin chatId 发送通知（不创建群聊）。Phase 2 将集成 lark-cli 群创建。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 30 分钟
- **最大并行**: 3 个 reviewing PR
- **状态超时**: 48 小时

## 前置依赖

- `scanner.ts`（本目录下的 CLI 脚本，Issue #2219）
- `gh` CLI（GitHub 命令行工具）
- `send_interactive` MCP 工具（交互式卡片）

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx schedules/pr-scanner/scanner.ts --action check-capacity
```

如果 `available` 为 0，**退出本次执行**（已达最大并行数）。

### Step 2: 发现待审 PR

```bash
npx tsx schedules/pr-scanner/scanner.ts --action list-candidates
```

如果 `candidates` 为空数组，**退出本次执行**（无新 PR）。

### Step 3: 获取 PR 详情

对第一个候选 PR，获取详细信息：

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles,labels
```

### Step 4: 创建状态文件

使用本 schedule 的 `chatId`（Phase 1 回退方案，不创建群聊）：

```bash
npx tsx schedules/pr-scanner/scanner.ts --action create-state \
  --pr {number} --chat-id {chatId}
```

> 此步骤会自动为 PR 添加 `pr-scanner:reviewing` label（非阻塞，失败不影响主流程）。

### Step 5: 发送 PR 详情卡片

使用 `send_interactive` 发送交互式卡片：

```json
{
  "question": "## PR #{number}: {title}\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 🔍 CI | {ciStatus} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |\n\n### 描述\n{body 前 500 字符}\n\n---\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})",
  "options": [
    { "text": "✅ Approve", "value": "approve", "type": "primary" },
    { "text": "❌ Request Changes", "value": "request_changes" },
    { "text": "🔄 Close PR", "value": "close", "type": "danger" }
  ],
  "title": "🔍 PR Review: #{number}",
  "chatId": "{chatId}",
  "actionPrompts": {
    "approve": "[用户操作] 用户批准 PR #{number}。请执行：\n1. 检查 CI 状态是否通过\n2. 执行 `gh pr review {number} --repo hs3180/disclaude --approve --body \"Approved via PR Scanner\"`\n3. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state approved`\n4. 报告执行结果",
    "request_changes": "[用户操作] 用户请求修改 PR #{number}。请询问用户具体修改意见，然后执行 `gh pr review {number} --repo hs3180/disclaude --request-changes --body \"{修改意见}\"`",
    "close": "[用户操作] 用户关闭 PR #{number}。请执行：\n1. `gh pr close {number} --repo hs3180/disclaude`\n2. `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state closed`\n3. 报告执行结果"
  }
}
```

> **注意**: `actionPrompts` 中的 `{number}` 需要替换为实际 PR 编号。

### Step 6: 确认完成

输出本次扫描结果摘要：

```
✅ PR #{number} 已进入 reviewing 状态
- 状态文件: .temp-chats/pr-{number}.json
- Label: pr-scanner:reviewing
- 卡片已发送至 chatId
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| scanner.ts 执行失败 | 记录错误，退出本次执行 |
| `gh pr view` 失败 | 记录错误，跳过该 PR |
| `create-state` 失败（文件已存在） | 跳过，该 PR 已在追踪中 |
| Label 添加失败 | 不阻塞，scanner.ts 内部处理 |
| `send_interactive` 失败 | 记录错误，状态文件已创建（下次可手动重试） |
| 无候选 PR | 正常退出，无需操作 |
| 容量已满 | 正常退出，等待下次调度 |

## 状态转换

```
新 PR → create-state (reviewing) → 等待用户操作 → mark (approved/closed)
```

| 操作 | Label 变化 | State 变化 |
|------|-----------|------------|
| create-state | + `pr-scanner:reviewing` | → reviewing |
| approve | - `pr-scanner:reviewing` | → approved |
| close | - `pr-scanner:reviewing` | → closed |
| request_changes | 无变化 | 保持 reviewing |

## 不包含

- 讨论群生命周期管理（Sub-Issue C / Issue #2221）
- 文件锁修复（Sub-Issue D / Issue #2222，已关闭）

## 关联

- Parent: #2210
- Depends on: #2219 (scanner.ts 基础脚本)
- This: #2220 (SCHEDULE.md + GitHub Label 集成)
