---
name: "PR Scanner v2"
cron: "0 */30 * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_ADMIN_CHAT_ID"
createdAt: "2026-04-20T00:00:00.000Z"
---

# PR Scanner v2 — Schedule Prompt

定期扫描仓库的 open PR，通过 `scanner.ts` 管理状态，使用 GitHub Label 追踪进度，发送交互式卡片供人工审批。

## 配置

- **仓库**: hs3180/disclaude（可通过 `PR_SCANNER_REPO` 环境变量覆盖）
- **扫描间隔**: 每 30 分钟
- **并行上限**: 最多 3 个 reviewing（`DEFAULT_MAX_REVIEWING`）
- **状态目录**: `.temp-chats/`（可通过 `PR_SCANNER_DIR` 环境变量覆盖）
- **状态过期**: 48 小时

## 前置依赖

- `gh` CLI（已认证，有 repo 权限）
- `npx tsx`（运行 scanner.ts）
- `lark-cli`（飞书群操作，Phase 2 需要；Phase 1 可降级）

## 职责边界

- ✅ 扫描 open PR，发现待审候选
- ✅ 管理状态文件（`.temp-chats/pr-{number}.json`）
- ✅ GitHub Label 添加/移除（`pr-scanner:reviewing`）
- ✅ 发送 PR 详情交互卡片（`send_interactive`）
- ✅ 处理用户审批操作（Approve / Request Changes / Close）
- ❌ 讨论群生命周期管理（Sub-Issue C / Phase 2）
- ❌ 文件锁（Sub-Issue D）

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx schedules/pr-scanner/scanner.ts --action check-capacity
```

解析 JSON 输出。如果 `available === 0`，**退出本次执行**（已达并行上限）。

### Step 2: 发现待审 PR

```bash
npx tsx schedules/pr-scanner/scanner.ts --action list-candidates
```

解析 JSON 输出，获取候选 PR 列表（已排除已有状态文件的 PR）。如果列表为空，**退出本次执行**。

### Step 3: 获取 PR 详情

对第一个候选 PR 获取详细信息：

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json number,title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles,reviewDecision,url
```

### Step 4: 创建群聊（Phase 2）

> **Phase 1 降级**: 如果 `lark-cli` 不可用或群创建失败，使用 Schedule 配置的 `chatId`（admin 群）作为通知目标。

尝试通过 `lark-cli` 创建讨论群：

```bash
lark-cli im +chat-create --name "PR #{number} 审查" --users {author_open_id}
```

如果成功，使用返回的 `chat_id`；否则使用配置的 `chatId`。

### Step 5: 创建状态文件 + 添加 Label

```bash
npx tsx schedules/pr-scanner/scanner.ts --action create-state --pr {number}
```

此命令会：
1. 在 `.temp-chats/pr-{number}.json` 写入状态文件（state=reviewing）
2. 自动添加 `pr-scanner:reviewing` GitHub Label（失败不阻塞）

### Step 6: 发送 PR 详情交互卡片

使用 `send_interactive`（format: "card"）发送 PR 详情卡片到目标 chatId：

**卡片内容**:
```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"content": "🔍 PR #{number}: {title 前50字符}", "tag": "plain_text"},
    "template": "blue"
  },
  "elements": [
    {"tag": "markdown", "content": "**PR #{number}**: {title}\n\n| 属性 | 值 |\n|------|-----|\n| 👤 作者 | {author} |\n| 🌿 分支 | {headRef} → {baseRef} |\n| 📊 合并状态 | {mergeable ? '✅ 可合并' : '⚠️ 有冲突'} |\n| 🔍 CI 检查 | {ciStatus} |\n| 📈 变更 | +{additions} -{deletions} ({changedFiles} files) |\n| 🔗 链接 | [查看 PR]({url}) |\n\n### 📋 描述\n{body 前500字符}"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve-{number}", "type": "primary"},
      {"tag": "button", "text": {"content": "❌ Request Changes", "tag": "plain_text"}, "value": "request-changes-{number}", "type": "default"},
      {"tag": "button", "text": {"content": "🔄 Close", "tag": "plain_text"}, "value": "close-{number}", "type": "danger"}
    ]}
  ]
}
```

**actionPrompts**:
```json
{
  "approve-{number}": "[用户操作] 用户批准了 PR #{number}。请执行以下步骤：\n1. 运行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state approved`\n2. 执行 `gh pr review {number} --repo hs3180/disclaude --approve`\n3. 报告执行结果",
  "request-changes-{number}": "[用户操作] 用户请求修改 PR #{number}。请询问用户需要修改的具体内容，然后执行 `gh pr review {number} --repo hs3180/disclaude --request-changes --body \"{修改意见}\"`。注意：不改变 state 文件状态。",
  "close-{number}": "[用户操作] 用户关闭 PR #{number}。请执行以下步骤：\n1. 运行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state closed`\n2. 执行 `gh pr close {number} --repo hs3180/disclaude`\n3. 报告执行结果"
}
```

### Step 7: Label 兜底（可选）

如果 Step 5 中 label 添加失败，作为兜底再次尝试：

```bash
npx tsx schedules/pr-scanner/scanner.ts --action add-label --pr {number}
```

失败则忽略，不阻塞流程。

## 状态管理

### 状态文件 Schema (`.temp-chats/pr-{number}.json`)

```json
{
  "prNumber": 123,
  "chatId": "oc_xxx 或 null",
  "state": "reviewing",
  "createdAt": "2026-04-20T10:00:00Z",
  "updatedAt": "2026-04-20T10:00:00Z",
  "expiresAt": "2026-04-22T10:00:00Z",
  "disbandRequested": null
}
```

### GitHub Label

| Label | 含义 | 生命周期 |
|-------|------|----------|
| `pr-scanner:reviewing` | PR 正在审查中 | create-state 添加，mark 离开 reviewing 时移除 |

### 状态转换

```
新 PR → create-state (reviewing) → [用户操作]
  ├─ Approve → mark approved → 移除 label
  ├─ Request Changes → 不改变 state
  └─ Close → mark closed → 移除 label
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `gh` CLI 失败 | 记录错误，跳过该 PR |
| `scanner.ts` 执行失败 | 记录错误，退出本次执行 |
| Label 添加/移除失败 | 记录警告，不阻塞主流程 |
| `lark-cli` 不可用 | 降级到 admin chatId 发送通知 |
| 群创建失败 | 降级到 admin chatId 发送通知 |
| `send_interactive` 失败 | 记录错误，PR 仍处于 tracking 状态 |
| 并发容量已满 | 静默退出，等待下次扫描 |

## 注意事项

1. **串行处理**: 每次执行只处理一个候选 PR，避免并发问题
2. **幂等性**: `create-state` 对已存在的 PR 会报错，不会重复创建
3. **Label 非阻塞**: Label 操作失败不影响状态文件和主流程
4. **Phase 1 降级**: 群聊创建失败时回退到固定 chatId
5. **有限并行**: 最多 3 个 reviewing 状态的 PR
6. **不创建新 Schedule**: 这是定时任务执行环境的规则
7. **不修改其他文件**: 只操作 `.temp-chats/` 目录和 GitHub Label

## 验收标准

- [ ] Schedule 可被 Scheduler 正常触发
- [ ] scanner.ts 输出 JSON 可被 AI Agent 解析
- [ ] `send_interactive` 卡片按钮可点击并触发正确 actionPrompt
- [ ] Label 正确添加/移除（create-state 添加，mark 离开 reviewing 时移除）
- [ ] 容量限制生效（max 3 reviewing）
- [ ] 错误路径有回退方案（lark-cli 不可用 → admin chatId）

## 相关

- Parent: #2210
- Depends on: #2219 (scanner.ts 基础脚本)
- Design: `docs/designs/pr-scanner-design.md`
