---
name: "PR Scanner v2"
cron: "0 */15 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-08T00:00:00.000Z
---

# PR Scanner v2 — 定时扫描 PR + 状态管理

定期扫描仓库的 open PR，管理 review 状态，并发送通知到管理群。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 15 分钟
- **最大并行 reviewing**: 3（可通过 `PR_SCANNER_MAX_REVIEWING` 环境变量覆盖）
- **状态目录**: `workspace/pr-scanner/`

## 前置依赖

- `gh` CLI（GitHub 官方命令行工具）

> **⚠️ 平台要求**: 本 Schedule 使用 TypeScript 实现，通过 `tsx` 运行。遵循 `chats-activation` / `chat-timeout` 的实现模式。

## 执行步骤

```bash
npx tsx scripts/schedule/pr-scanner.ts scan
```

脚本完整实现了以下逻辑：

### Step 0: 环境检查（fail-fast）

检查 `gh` CLI 是否可用。**缺失则立即终止**（`exit 1`）。

### Step 1: 加载现有状态

从 `workspace/pr-scanner/` 目录读取所有 `pr-{number}.json` 状态文件，统计当前 reviewing 数量。

### Step 2: 获取 open PR 列表

通过 `gh pr list` 获取所有 open PR（最多 100 个），包含：number, title, author, headRefName, baseRefName, mergeable, additions, deletions, changedFiles, labels, updatedAt。

### Step 3: 过滤已跟踪的 PR

排除以下 PR：
- 已有状态文件（`workspace/pr-scanner/pr-{number}.json` 存在）
- 已有 `pr-scanner:reviewing` label（外部添加）

### Step 4: 按优先级排序

按 `updatedAt` 升序排列（最久未更新的 PR 优先处理）。

### Step 5: 并发限制检查

如果当前 reviewing 数量已达到 `PR_SCANNER_MAX_REVIEWING`（默认 3），跳过本次扫描。

### Step 6: 创建状态文件并标记

对每个新 PR（在并发限制内）：
1. **文件锁保护** — `fs.flock` 排他锁，防止并发写入
2. **幂等检查** — 锁内二次确认状态文件不存在
3. **写入状态文件** — `pr-{number}.json`，status=reviewing
4. **添加 GitHub Label** — `pr-scanner:reviewing`

### Step 7: 输出扫描摘要

脚本输出 JSON 格式的扫描摘要（`---SCAN_SUMMARY---` 标记后），包含新发现的 PR 列表。AI Agent 应根据摘要发送通知。

## 状态管理

### 状态文件

| 文件 | 内容 |
|------|------|
| `workspace/pr-scanner/pr-{number}.json` | 单个 PR 的 review 状态 |

### 状态文件 Schema

```json
{
  "number": 1234,
  "title": "PR title",
  "author": "username",
  "headRefName": "feature/branch",
  "baseRefName": "main",
  "status": "reviewing",
  "createdAt": "2026-04-08T00:00:00Z",
  "updatedAt": "2026-04-08T00:00:00Z",
  "notifiedAt": null,
  "chatId": null,
  "mergeable": true,
  "additions": 100,
  "deletions": 50,
  "changedFiles": 5
}
```

### 状态转换

| 当前状态 | 条件 | 新状态 |
|----------|------|--------|
| （新 PR） | 扫描发现 | `reviewing` |
| `reviewing` | 用户批准 | `approved` |
| `reviewing` | 用户拒绝 | `rejected` |
| `reviewing` | PR 关闭 | `closed` |

### GitHub Label

| Label | 含义 |
|-------|------|
| `pr-scanner:reviewing` | 正在 review 中 |

> **唯一 Label**: v2 仅使用一个 Label `pr-scanner:reviewing`，状态文件是唯一数据源。

## 通知流程

扫描完成后，AI Agent 应对每个新发现的 PR 发送通知卡片到管理群：

### PR 通知卡片

**卡片内容**（format: "card"）：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "🔔 新 PR 待 Review", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "**PR #{number}**: {title}\n\n👤 作者: {author}\n🌿 分支: {headRef} → {baseRef}\n📊 合并状态: {mergeable}\n📈 变更: +{additions} -{deletions} ({changedFiles} files)\n\n🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/{number})"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ Approve", "tag": "plain_text"}, "value": "approve-{number}", "type": "primary"},
      {"tag": "button", "text": {"content": "🔄 Request Changes", "tag": "plain_text"}, "value": "changes-{number}", "type": "default"},
      {"tag": "button", "text": {"content": "❌ Close", "tag": "plain_text"}, "value": "close-{number}", "type": "danger"}
    ]}
  ]
}
```

**actionPrompts**：
```json
{
  "approve-{number}": "[用户操作] 用户批准 PR #{number}。请执行：\n1. 运行 `npx tsx scripts/schedule/pr-scanner.ts mark {number} approved`\n2. 报告执行结果",
  "changes-{number}": "[用户操作] 用户请求修改 PR #{number}。请使用 `gh pr comment --repo hs3180/disclaude --body \"...\" {number}` 添加评论，询问需要修改的具体内容。",
  "close-{number}": "[用户操作] 用户关闭 PR #{number}。请执行：\n1. 运行 `gh pr close --repo hs3180/disclaude {number}`\n2. 运行 `npx tsx scripts/schedule/pr-scanner.ts mark {number} closed`\n3. 报告执行结果"
}
```

## 其他命令

```bash
# 查看当前状态
npx tsx scripts/schedule/pr-scanner.ts status

# 手动标记 PR 状态
npx tsx scripts/schedule/pr-scanner.ts mark <pr-number> <approved|rejected|closed|reviewing>
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `gh` CLI 不可用 | 立即终止执行（exit 1） |
| GitHub API 限流 | 记录错误，下次扫描重试 |
| Label 添加失败 | 记录警告，状态文件是唯一数据源 |
| 状态文件损坏 | 跳过该文件，不阻塞其他 PR |
| 并发写入 | `fs.flock` 排他锁保护 |

## 注意事项

1. **文件优先**: 状态文件（`workspace/pr-scanner/`）是唯一数据源，GitHub Label 仅作辅助标识
2. **有限并行**: 最多同时 reviewing 3 个 PR，避免通知过多
3. **幂等性**: 重复执行不会产生副作用（锁内二次检查）
4. **无状态**: Schedule 不维护内存状态，所有状态从文件读取
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只操作 `workspace/pr-scanner/` 目录
7. **并发安全**: 使用 `fs.flock` 文件锁防止多个 Schedule 实例同时处理同一 PR

## 关联 Issue

- #2210 — PR Scanner v2 实现
- #393 — 原始 PR Scanner Issue（已关闭）
