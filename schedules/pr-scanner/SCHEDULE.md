---
name: "PR Scanner v2 (Schedule Prompt)"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner v2 — SCHEDULE.md

基于 scanner.ts CLI + GitHub Label 的 PR 发现 → 群创建 → 通知完整流程。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并行 reviewing**: 3
- **PR 审查超时**: 48 小时

## 前置依赖

- `gh` CLI（GitHub CLI，已认证）
- `lark-cli`（飞书官方 CLI，用于群聊创建回退）
- `npx tsx`（TypeScript 执行器）
- scanner.ts（Issue #2219）
- label-manager.ts（本 PR 提供）

## 执行步骤

### Step 1: 检查并行容量

检查当前 reviewing 状态的 PR 数量，确保不超过上限（max 3）。

```bash
npx tsx schedules/pr-scanner/scanner.ts --action check-capacity
```

如果输出 `{"available": false}`，说明容量已满，**退出本次执行**。

### Step 2: 发现待审 PR

列出所有没有状态文件的 open PR（即尚未被 scanner 跟踪的 PR）。

```bash
npx tsx schedules/pr-scanner/scanner.ts --action list-candidates
```

如果输出为空数组 `[]`，说明没有新的待审 PR，**退出本次执行**。

### Step 3: 获取 PR 详情

取第一个候选 PR，获取完整信息。

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json number,title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles,labels
```

解析输出，提取以下字段：
- `number` — PR 编号
- `title` — PR 标题
- `body` — PR 描述（截取前 300 字符）
- `author.login` — 作者
- `headRefName` — 源分支
- `baseRefName` — 目标分支
- `mergeable` — 是否可合并
- `statusCheckRollup` — CI 状态
- `additions` / `deletions` — 变更行数
- `changedFiles` — 变更文件数

### Step 4: lark-cli 群创建（Phase 2 实现，Phase 1 回退到 admin chatId）

**Phase 2**: 使用 `start_group_discussion` 工具创建讨论群（当 MCP 工具可用时）。

**Phase 1 回退**: 直接在配置的 chatId 中发送通知。

### Step 5: 创建状态文件

为该 PR 创建状态跟踪文件（48 小时超时）。

```bash
npx tsx schedules/pr-scanner/scanner.ts --action create-state --pr {number} --chat-id {chatId}
```

### Step 6: 添加 reviewing Label

使用 label-manager 为 PR 添加 `pr-scanner:reviewing` label。

```bash
npx tsx schedules/pr-scanner/label-manager.ts --action add --pr {number} --label "pr-scanner:reviewing"
```

**⚠️ Label 操作失败不阻塞主流程**。如果 `gh label` 命令失败，记录警告并继续。

### Step 7: 发送 PR 详情卡片

使用 `send_interactive`（非 `send_card`）发送 PR 详情和操作选项卡片。

**卡片内容**（format: "card"）：
```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "🔍 PR #{number}: {title}", "tag": "plain_text"}, "template": "blue"},
    "elements": [
      {"tag": "markdown", "content": "**👤 作者**: {author}\n**🌿 分支**: `{headRef}` → `{baseRef}`\n**📊 合并状态**: {mergeable ? '✅ 可合并' : '⚠️ 有冲突'}\n**🔍 CI 检查**: {ciStatus}\n**📈 变更**: +{additions} -{deletions} ({changedFiles} files)"},
      {"tag": "hr"},
      {"tag": "markdown", "content": "**📋 描述**\n{description 前300字符}\n\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve-{number}", "type": "primary"},
        {"tag": "button", "text": {"content": "❌ Request Changes", "tag": "plain_text"}, "value": "request-changes-{number}"},
        {"tag": "button", "text": {"content": "🔄 Close", "tag": "plain_text"}, "value": "close-{number}", "type": "danger"},
        {"tag": "button", "text": {"content": "⏳ Skip", "tag": "plain_text"}, "value": "skip-{number}"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "{chatId}",
  "actionPrompts": {
    "approve-{number}": "[用户操作] 用户批准了 PR #{number}。请执行：\n1. 执行 `gh pr review {number} --repo hs3180/disclaude --approve`\n2. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state approved`\n3. 执行 `npx tsx schedules/pr-scanner/label-manager.ts --action remove --pr {number} --label \"pr-scanner:reviewing\"`\n4. 报告执行结果",
    "request-changes-{number}": "[用户操作] 用户请求修改 PR #{number}。请询问用户需要修改的具体内容，然后使用 `gh pr review {number} --repo hs3180/disclaude --request-changes -b \"{修改意见}\"` 添加评论。PR 保持在 reviewing 状态。",
    "close-{number}": "[用户操作] 用户关闭 PR #{number}。请执行：\n1. 执行 `gh pr close {number} --repo hs3180/disclaude`\n2. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state closed`\n3. 执行 `npx tsx schedules/pr-scanner/label-manager.ts --action remove --pr {number} --label \"pr-scanner:reviewing\"`\n4. 报告执行结果",
    "skip-{number}": "[用户操作] 用户跳过 PR #{number}。执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state closed` 并移除 reviewing label。下次扫描不会再处理此 PR。"
  }
}
```

## 状态管理

### Label 定义

| Label | 含义 | 颜色建议 |
|-------|------|----------|
| `pr-scanner:reviewing` | 正在被 scanner 跟踪审查 | `#0075ca` (蓝色) |
| `pr-scanner:approved` | 已通过审查 | `#0e8a16` (绿色) |

### 状态转换

```
新 PR → create-state → 添加 reviewing label → 发送卡片
  → Approve → mark approved → 移除 reviewing label
  → Request Changes → 保持 reviewing（用户在群聊中讨论后重新提交）
  → Close → mark closed → 移除 reviewing label
  → Skip → mark closed → 移除 reviewing label
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `gh` CLI 未认证 | 记录错误，退出执行 |
| scanner.ts 执行失败 | 记录错误，跳过该 PR |
| lark-cli 不可用 | 回退到 admin chatId 发送通知 |
| Label 操作失败 | 记录警告，**不阻塞**主流程 |
| send_interactive 失败 | 记录错误，PR 状态文件已创建（下次可恢复） |
| 容量已满 | 退出本次执行，等待下次扫描 |

## 注意事项

1. **幂等性**: 重复执行不会重复创建状态文件或发送通知（scanner.ts 的 `list-candidates` 会排除已有状态文件的 PR）
2. **Label 兜底**: Label 操作失败不阻塞主流程，状态文件是核心状态管理
3. **无状态设计**: 所有状态通过文件（`.temp-chats/`）和 GitHub Label 双重管理
4. **容量限制**: 最多 3 个 PR 同时处于 reviewing 状态，防止审查质量下降
5. **串行处理**: 每次执行只处理 1 个新 PR，避免并发问题
6. **不创建新 Schedule**: 这是定时任务执行环境的规则
7. **回退策略**: 群聊创建失败时回退到 admin chatId，确保通知送达

## 验收标准

- [ ] Schedule 可被 Scheduler 正常触发
- [ ] scanner.ts 输出 JSON 可被 AI Agent 解析
- [ ] `send_interactive` 卡片按钮可点击并触发正确 actionPrompt
- [ ] Label 正确添加/移除（reviewing / approved）
- [ ] 容量限制生效（max 3 reviewing）
- [ ] 错误路径有回退方案

## 不包含

- 讨论群生命周期管理（Sub-Issue C / Phase 2，Issue #2221）
- 文件锁（由 scanner.ts 内部处理）

## 关联

- Parent: #2210
- Depends on: #2219 (scanner.ts)
- Next: #2221 (讨论群生命周期管理)
