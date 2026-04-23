---
name: "PR Scanner"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner - 扫描与通知

定期扫描仓库的 open PR，发现新 PR 时发送通知卡片，支持用户交互操作。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并行**: 3 个 reviewing 状态
- **状态目录**: `.temp-chats/`
- **超时**: 48 小时（自动过期）

## 前置依赖

- `gh` CLI（GitHub 操作）
- `schedules/pr-scanner.ts`（状态管理脚本）

## 环境变量

```bash
export PR_SCANNER_REPO="hs3180/disclaude"
export PR_SCANNER_MAX_CONCURRENT=3
```

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx schedules/pr-scanner.ts --action check-capacity
```

解析 JSON 输出：
```json
{ "reviewing": 0, "maxConcurrent": 3, "available": 3 }
```

- 如果 `available === 0`，**退出本次执行**（容量已满）

### Step 2: 发现待审 PR

```bash
npx tsx schedules/pr-scanner.ts --action list-candidates
```

解析 JSON 输出（未跟踪的 open PR 列表）：
```json
[{ "number": 123, "title": "feat: new feature" }]
```

- 如果返回空数组 `[]`，**退出本次执行**（无需处理）
- 取**第一个**候选 PR 作为处理对象

### Step 3: 获取 PR 详情

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles,labels
```

### Step 4: 发送 PR 详情卡片

使用 `send_interactive` 发送 PR 信息卡片到配置的 `chatId`：

```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "🔔 新 PR 待审: #{number}", "tag": "plain_text"}, "template": "blue"},
    "elements": [
      {"tag": "markdown", "content": "**PR #{number}**: {title}\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |"},
      {"tag": "markdown", "content": "### 📋 描述\n{body 前500字符}\n\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve", "type": "primary"},
        {"tag": "button", "text": {"content": "🔄 Request Changes", "tag": "plain_text"}, "value": "request_changes"},
        {"tag": "button", "text": {"content": "❌ Close PR", "tag": "plain_text"}, "value": "close"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "oc_71e5f41a029f3a120988b7ecb76df314",
  "actionPrompts": {
    "approve": "[用户操作] 用户批准 PR #{number}。请执行：\n1. 检查 CI 状态是否通过\n2. `npx tsx schedules/pr-scanner.ts --action mark --pr {number} --state approved`\n3. `gh pr review {number} --repo hs3180/disclaude --approve`\n4. 报告结果",
    "request_changes": "[用户操作] 用户请求修改 PR #{number}。请询问用户需要修改的具体内容，然后用 `gh pr review {number} --repo hs3180/disclaude --request-changes -b \"修改意见\"` 提交 review。",
    "close": "[用户操作] 用户关闭 PR #{number}。请执行：\n1. `npx tsx schedules/pr-scanner.ts --action mark --pr {number} --state closed`\n2. `gh pr close {number} --repo hs3180/disclaude`\n3. 报告结果"
  }
}
```

**注意**: 将 `{number}`、`{title}` 等占位符替换为 Step 3 获取的实际值。

### Step 5: 创建状态文件

```bash
npx tsx schedules/pr-scanner.ts --action create-state --pr {number}
```

此操作会：
1. 在 `.temp-chats/pr-{number}.json` 创建状态文件（state: `reviewing`）
2. 自动添加 `pr-scanner:reviewing` GitHub Label（best-effort，失败不阻塞）

### Step 6: 兜底 Label（可选）

如果 Step 5 的 label 操作可能失败（如 PR_SCANNER_REPO 未设置），手动兜底：

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:reviewing"
```

Label 失败不影响主流程。

## 状态管理

### 状态文件

位置: `.temp-chats/pr-{number}.json`

```json
{
  "prNumber": 123,
  "chatId": null,
  "state": "reviewing",
  "createdAt": "2026-04-24T10:00:00Z",
  "updatedAt": "2026-04-24T10:00:00Z",
  "expiresAt": "2026-04-26T10:00:00Z",
  "disbandRequested": null
}
```

### 状态转换

```
新 PR → create-state (reviewing) → 用户操作 → mark (approved/closed)
                                          ↘ 48h 过期 → chat-timeout 处理
```

### Label 管理

| 时机 | 操作 | 说明 |
|------|------|------|
| `create-state` | 添加 `pr-scanner:reviewing` | 标记 PR 正在被审阅 |
| `mark approved` | 移除 `pr-scanner:reviewing` | 用户批准，移除审阅标记 |
| `mark closed` | 移除 `pr-scanner:reviewing` | PR 关闭，移除审阅标记 |

> **注意**: Label 操作是 best-effort 的，失败仅记录警告，不阻塞主流程。

### 查看当前状态

```bash
npx tsx schedules/pr-scanner.ts --action status
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `gh` 命令失败 | 记录错误，跳过该 PR |
| `check-capacity` 容量为 0 | 退出本次执行 |
| `list-candidates` 返回空 | 退出本次执行 |
| `create-state` 文件已存在 | 跳过（PR 已在跟踪中） |
| Label 操作失败 | 记录警告，不阻塞主流程 |
| `send_interactive` 失败 | 状态文件已创建，下次手动处理 |

## 注意事项

1. **串行处理**: 每次只处理一个新 PR，避免并发问题
2. **容量限制**: 最多 3 个 PR 同时处于 reviewing 状态
3. **幂等性**: 重复执行不会创建重复状态文件
4. **不自动合并**: 所有操作需用户通过卡片按钮确认
5. **不创建新 Schedule**: 定时任务执行规则
6. **不修改其他文件**: 只操作 `.temp-chats/` 下的状态文件

## 依赖

- `gh` CLI
- `schedules/pr-scanner.ts`（状态管理脚本，Issue #2219）
- GitHub Label: `pr-scanner:reviewing`

## 关联

- Parent: #2210
- Depends on: #2219
- Design: docs/designs/pr-scanner-design.md
