---
name: "PR Scanner v2 (Parallel)"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner v2 — SCHEDULE.md + GitHub Label 集成

定期扫描仓库的 open PR，并行处理（max 3），为每个 PR 创建状态追踪并发送交互式通知。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **并行上限**: 3 个 reviewing PR
- **过期时间**: 48 小时
- **状态目录**: `.temp-chats/`

## 前置依赖

- `npx tsx` — 运行 scanner.ts
- `gh` CLI — GitHub 操作（已通过 GH_TOKEN 认证）
- `send_interactive` MCP 工具 — 发送交互式卡片

## 执行步骤

### Step 1: 检查并行容量

```bash
npx tsx schedules/pr-scanner/scanner.ts --action check-capacity
```

检查当前有多少个 `reviewing` 状态的 PR。如果 `available === 0`，**退出本次执行**。

输出格式:
```json
{
  "reviewing": 1,
  "maxConcurrent": 3,
  "available": 2
}
```

### Step 2: 发现待审 PR

```bash
npx tsx schedules/pr-scanner/scanner.ts --action list-candidates
```

列出所有 open PR 中尚未被追踪的（即 `.temp-chats/` 中没有对应状态文件的 PR）。

输出格式:
```json
{
  "candidates": [
    { "number": 123, "title": "feat: some feature" },
    { "number": 124, "title": "fix: some bug" }
  ]
}
```

如果 `candidates` 为空，**退出本次执行**。

### Step 3: 逐个处理候选 PR

对每个候选 PR（不超过 Step 1 报告的 available 数量），执行以下子步骤：

#### 3a. 获取 PR 详情

```bash
gh pr view {number} --repo hs3180/disclaude \
  --json title,body,author,headRefName,baseRefName,mergeable,statusCheckRollup,additions,deletions,changedFiles,url
```

#### 3b. 确定通知 chatId

**Phase 1（当前）**: 使用固定的 admin chatId `oc_71e5f41a029f3a120988b7ecb76df314`。

> Phase 2 将使用 `lark-cli` 为每个 PR 创建独立讨论群，此时 chatId 来自群创建结果。

#### 3c. 创建状态文件（+ 添加 Label）

```bash
npx tsx schedules/pr-scanner/scanner.ts --action create-state \
  --pr {number} --chat-id {chatId}
```

此命令会：
1. 在 `.temp-chats/pr-{number}.json` 创建状态文件
2. 自动为 PR 添加 `pr-scanner:reviewing` label（失败不阻塞）

#### 3d. 发送 PR 详情交互式卡片

使用 `send_interactive` MCP 工具（非 `send_card`）发送通知。

**参数**:
```json
{
  "title": "🔔 PR #{number}: {title}",
  "context": "**作者**: {author}  |  **分支**: {headRef} → {baseRef}\n**变更**: +{additions}/-{deletions} ({changedFiles} files)  |  **可合并**: {mergeable}\n\n{body 前500字符}",
  "question": "请选择对此 PR 的处理方式：",
  "options": [
    { "text": "✅ Approve", "value": "approve", "type": "primary" },
    { "text": "🔄 Request Changes", "value": "request_changes" },
    { "text": "❌ Close", "value": "close", "type": "danger" }
  ],
  "chatId": "{chatId}",
  "actionPrompts": {
    "approve": "[用户操作] 用户批准 PR #{number}。请执行：1. 检查 CI 状态 2. 执行 `gh pr review {number} --repo hs3180/disclaude --approve --body \"Approved via PR Scanner\"` 3. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state approved` 4. 报告结果",
    "request_changes": "[用户操作] 用户要求修改 PR #{number}。请询问用户需要修改的具体内容，然后使用 `gh pr review {number} --repo hs3180/disclaude --request-changes --body \"用户的修改意见\"`",
    "close": "[用户操作] 用户关闭 PR #{number}。请执行：1. `gh pr close {number} --repo hs3180/disclaude` 2. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state closed` 3. 报告结果"
  }
}
```

**注意**: `{number}` 等占位符在实际发送前必须替换为真实值。actionPrompts 中的指令让 AI Agent 在用户点击按钮后执行对应操作。

#### 3e. 兜底 Label 检查

确认 label 已添加（Step 3c 已自动添加）。如果 `send_interactive` 失败，手动执行：

```bash
gh pr edit {number} --repo hs3180/disclaude --add-label "pr-scanner:reviewing"
```

## 状态管理

### 状态文件

| 字段 | 说明 |
|------|------|
| `prNumber` | PR 编号 |
| `chatId` | 通知发送的 chatId |
| `state` | 当前状态: `reviewing` / `approved` / `closed` |
| `createdAt` | 创建时间 (ISO 8601 Z) |
| `updatedAt` | 最后更新时间 |
| `expiresAt` | 过期时间 (createdAt + 48h) |
| `disbandRequested` | 解散申请时间 (Phase 1 固定为 null) |

### GitHub Label

| Label | 含义 |
|-------|------|
| `pr-scanner:reviewing` | PR 正在被 scanner 追踪 |

Label 生命周期：
- `create-state` → 自动添加
- `mark` (离开 reviewing) → 自动移除
- Label 操作失败不阻塞主流程

### 状态转换

```
新 PR → create-state (reviewing) → [用户点击按钮] → mark (approved/closed)
                                    ↓
                         send_interactive 卡片
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `available === 0` | 退出本次执行，下次再试 |
| `candidates` 为空 | 退出本次执行 |
| `gh pr view` 失败 | 记录错误，跳过该 PR |
| `create-state` 文件已存在 | 跳过该 PR（可能已被处理） |
| `send_interactive` 失败 | Label 兜底保证 PR 被标记 |
| Label 操作失败 | 记录警告，不阻塞主流程 |
| `lark-cli` 不可用 | Phase 1 使用 admin chatId 回退 |

## 注意事项

1. **并行处理**: 一次最多处理 `available` 个 PR（max 3 reviewing）
2. **文件状态**: 所有状态通过 `.temp-chats/` JSON 文件管理
3. **Label 非阻塞**: Label 是辅助手段，核心状态在文件中
4. **Phase 1 回退**: 不创建讨论群，直接在 admin chatId 发送通知
5. **幂等性**: `create-state` 对已存在的文件会报错并跳过
6. **不自动操作**: 只发送通知和添加 label，等待用户交互后才执行 approve/close

## 验收标准

- [ ] Schedule 可被 Scheduler 正常触发
- [ ] scanner.ts 输出 JSON 可被 AI Agent 解析
- [ ] `send_interactive` 卡片按钮可点击并触发正确 actionPrompt
- [ ] Label 正确添加/移除
- [ ] 容量限制生效（max 3 reviewing）
- [ ] 错误路径有回退方案

## 不包含

- 讨论群生命周期管理（Sub-Issue C / Phase 2, #2221）
- 文件锁（Sub-Issue D）

## 关联

- Parent: #2210
- Depends on: #2219 (scanner.ts)
- Related: #2220
