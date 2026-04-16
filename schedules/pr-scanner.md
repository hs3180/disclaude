---
name: "PR Scanner (Serial)"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner v2 — 基于 scanner.ts 的串行扫描模式

定期扫描仓库的 open PR，使用 scanner.ts CLI 管理状态，为每个 PR 发送通知卡片。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并行**: 3 个 reviewing PR
- **状态文件目录**: `.temp-chats/`
- **Scanner 脚本**: `npx tsx schedules/pr-scanner/scanner.ts`

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx schedules/pr-scanner/scanner.ts --action check-capacity
```

输出 JSON 示例：
```json
{
  "reviewing": 1,
  "maxConcurrent": 3,
  "available": 2
}
```

如果 `available` 为 0，输出 "⏸️ 容量已满，跳过本次扫描" 并**退出**。

### Step 2: 获取候选 PR 列表

```bash
npx tsx schedules/pr-scanner/scanner.ts --action list-candidates --repo hs3180/disclaude
```

输出 JSON：未跟踪的 open PR 列表。如果列表为空，输出 "✅ 无新 PR" 并**退出**。

选择**第一个**候选 PR 作为处理对象。

### Step 3: 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles
```

解析返回的 JSON，提取以下信息用于通知：
- `title`, `author.login`
- `headRefName` → `baseRefName`
- `mergeable` (true/false)
- `statusCheckRollup` (CI 状态摘要)
- `additions`, `deletions`, `changedFiles`
- `body` (描述，截取前 500 字符)

### Step 4: 创建状态文件

在 Phase 1 中，使用 admin chatId 作为默认 chatId（群聊创建将在 Phase 2 实现）：

```bash
npx tsx schedules/pr-scanner/scanner.ts --action create-state \
  --pr {number} --chatId {admin_chatId}
```

如果返回错误（已存在状态文件），跳过该 PR，处理下一个候选。

### Step 5: 发送 PR 详情通知卡片

使用 `send_interactive` 工具发送可交互的 PR 详情卡片：

**参数**：
```json
{
  "chatId": "{chatId}",
  "title": "🔔 PR #{number} 等待审查",
  "question": "**PR #{number}**: {title}\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 🔍 CI 检查 | {ciStatus} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |\n\n### 📋 描述\n{body 前500字符}\n\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})",
  "options": [
    { "text": "✅ Approve", "value": "approve", "type": "primary" },
    { "text": "❌ Request Changes", "value": "request_changes", "type": "danger" },
    { "text": "🔄 Close PR", "value": "close", "type": "default" }
  ],
  "actionPrompts": {
    "approve": "[用户操作] 用户批准 PR #{number}。请执行以下步骤：\n1. 检查 CI 状态是否通过\n2. 执行 `gh pr review {number} --repo hs3180/disclaude --approve --body \"Approved via PR Scanner\"`\n3. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state approved`\n4. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action remove-label --pr {number} --repo hs3180/disclaude`\n5. 报告执行结果",
    "request_changes": "[用户操作] 用户请求修改 PR #{number}。请执行以下步骤：\n1. 询问用户需要修改的具体内容\n2. 使用 `gh pr review {number} --repo hs3180/disclaude --request-changes --body \"{用户输入的修改意见}\"` 提交修改请求\n3. 注意：不改变 state 文件，PR 保持 reviewing 状态等待作者更新\n4. 报告执行结果",
    "close": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. 执行 `gh pr close {number} --repo hs3180/disclaude`\n2. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state closed`\n3. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action remove-label --pr {number} --repo hs3180/disclaude`\n4. 报告执行结果"
  }
}
```

### Step 6: 添加 GitHub Label（兜底）

```bash
npx tsx schedules/pr-scanner/scanner.ts --action add-label \
  --pr {number} --repo hs3180/disclaude
```

此步骤为兜底操作，即使失败也不阻塞主流程。

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| scanner.ts 执行失败 | 记录错误，退出本次执行 |
| gh CLI 不可用 | 记录错误，退出本次执行 |
| send_interactive 失败 | 记录错误，回退到 `send_message` 发送纯文本通知 |
| Label 操作失败 | 忽略（scanner.ts 内部已处理为非阻塞） |
| 状态文件已存在 | 跳过该 PR，处理下一个候选 |

## 状态管理

### 状态文件 (`.temp-chats/pr-{number}.json`)

```json
{
  "prNumber": 123,
  "chatId": "oc_xxx",
  "state": "reviewing",
  "createdAt": "2026-04-07T10:00:00Z",
  "updatedAt": "2026-04-07T10:00:00Z",
  "expiresAt": "2026-04-09T10:00:00Z",
  "disbandRequested": null
}
```

### GitHub Label

| Label | 含义 |
|-------|------|
| `pr-scanner:reviewing` | 正在被 scanner 跟踪审查 |

### 状态转换

```
新 PR → create-state (reviewing) + add-label → send_interactive 卡片
    → 用户选择 Approve → mark approved + remove-label
    → 用户选择 Close → mark closed + remove-label
    → 用户选择 Request Changes → 保持 reviewing（等待更新）
    → 过期 (48h) → 仍在 reviewing（需手动处理）
```

## 注意事项

1. **串行处理**: 每次扫描只处理一个新 PR（取第一个候选）
2. **容量限制**: 最多同时 3 个 reviewing 状态的 PR
3. **文件驱动状态**: 通过 `.temp-chats/` 目录管理状态，不依赖 GitHub Label 做状态判断
4. **Label 兜底**: GitHub Label 仅作为可视化辅助，不参与核心逻辑
5. **Phase 1 限制**: 当前使用 admin chatId 发送通知，群聊创建将在 Phase 2 (#2221) 实现

## 依赖

- scanner.ts CLI (Issue #2219)
- gh CLI (GitHub API)
- send_interactive MCP Tool
- GitHub Label: `pr-scanner:reviewing`
