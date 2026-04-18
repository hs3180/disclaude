---
name: "Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-04-18T00:00:00.000Z"
---

# Discussion Lifecycle — PR 讨论群过期与解散管理

定期扫描过期的 PR 审阅讨论群，发送解散确认卡片，管理讨论群生命周期。

## 配置

- **状态目录**: `.temp-chats/`（scanner.ts 管理的 PR 状态文件）
- **扫描间隔**: 每 10 分钟
- **解散冷却期**: 24 小时（避免重复发送解散申请）
- **审阅超时**: 由 scanner.ts `create-state` 设置（默认 48 小时）

## 前置依赖

- `lifecycle.ts`（本 Schedule 通过 CLI 调用）
- `scanner.ts`（状态文件管理）
- `gh` CLI（GitHub Label 操作）
- `lark-cli`（飞书群组管理）
- `send_interactive` MCP 工具（发送交互式卡片）

## 执行步骤

### Step 1: 检查过期 PR

```bash
cd schedules/pr-scanner && npx tsx lifecycle.ts --action check-expired --cooldown-hours 24
```

解析 JSON 输出：
- `expired[]`: 所有过期的 PR 列表
- `expired[].needsDisbandRequest`: `true` 表示需要发送解散申请（冷却期已过）
- `total`: 扫描的总文件数
- `skippedCooldown`: 因冷却期跳过的数量

如果 `expired` 数组为空，**退出本次执行**。

### Step 2: 筛选需要发送解散申请的 PR

从 `expired` 中筛选 `needsDisbandRequest === true` 的 PR。

如果筛选结果为空（所有都在冷却期内），**退出本次执行**。

### Step 3: 对每个需要解散的 PR 发送确认卡片

对每个 `needsDisbandRequest === true` 的 PR，使用 `send_interactive` 发送确认卡片：

```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {
      "title": {"content": "⏰ PR 讨论群已过期 — 确认解散", "tag": "plain_text"},
      "template": "orange"
    },
    "elements": [
      {"tag": "markdown", "content": "PR #{prNumber} 的审阅讨论群已过期。\n\n| 属性 | 值 |\n|------|-----|\n| 🔢 PR | #{prNumber} |\n| ⏳ 过期时间 | {expiresAt} |\n| 📅 创建时间 | {createdAt} |\n\n该 PR 已超过审阅超时时间，请确认是否解散讨论群。"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "✅ 确认解散", "tag": "plain_text"}, "value": "confirm_disband", "type": "primary"},
        {"tag": "button", "text": {"content": "🔄 继续审阅", "tag": "plain_text"}, "value": "extend_review", "type": "default"},
        {"tag": "button", "text": {"content": "⏳ 稍后提醒", "tag": "plain_text"}, "value": "remind_later"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "{当前 chatId}",
  "actionPrompts": {
    "confirm_disband": "[用户操作] 用户确认解散 PR #{prNumber} 的讨论群。请执行以下步骤：\n1. 执行 `cd schedules/pr-scanner && npx tsx lifecycle.ts --action disband --pr {prNumber}`\n2. 检查返回结果：groupDissolved、stateFileDeleted 是否都为 true\n3. 报告执行结果",
    "extend_review": "[用户操作] 用户选择继续审阅 PR #{prNumber}。请执行以下步骤：\n1. 执行 `cd schedules/pr-scanner && npx tsx scanner.ts --action mark --pr {prNumber} --state reviewing`\n2. 这会重置 updatedAt 时间戳\n3. 下次 discussion-lifecycle 扫描时，如果 PR 仍然过期会再次提醒",
    "remind_later": "[用户操作] 用户选择稍后处理 PR #{prNumber}。不做任何操作，下次扫描时会再次提醒（24h 冷却期后）。"
  }
}
```

### Step 4: 标记已发送解散申请

对每个发送了解散申请的 PR，更新 `disbandRequested` 时间戳：

```bash
cd schedules/pr-scanner && npx tsx lifecycle.ts --action mark-disband --pr {prNumber}
```

这确保 24 小时内不会重复发送解散申请。

### Step 5: 处理确认解散

当用户点击 "确认解散" 按钮后，执行完整清理流程：

```bash
cd schedules/pr-scanner && npx tsx lifecycle.ts --action disband --pr {prNumber}
```

该命令会按顺序执行：
1. ✅ 验证 PR 状态仍为 `reviewing`（防止并发问题）
2. ✅ 通过 lark-cli 解散飞书群组（如有 chatId）
3. ✅ 移除 GitHub `pr-scanner:reviewing` label
4. ✅ 删除状态文件

如果验证失败（状态 ≠ reviewing），命令会返回错误，说明该 PR 已被处理。

## 状态转换

| 当前状态 | 条件 | 执行动作 | 结果 |
|----------|------|----------|------|
| `reviewing` | 过期 + 冷却期已过 | 发送解散卡片 + mark-disband | 等待用户确认 |
| `reviewing` | 过期 + 冷却期内 | 跳过 | 下次扫描再检查 |
| `reviewing` | 未过期 | 跳过 | 不处理 |
| `approved` / `closed` | 任何 | 不出现在 check-expired 结果中 | 不处理 |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| lifecycle.ts 执行失败 | 记录错误到 stderr，**退出本次执行** |
| send_interactive 发送失败 | 记录错误，跳过该 PR，处理下一个 |
| lark-cli 解散群组失败 | **不阻塞**，继续删除状态文件（群可能已被解散） |
| GitHub label 移除失败 | **不阻塞**，继续删除状态文件 |
| 状态文件删除失败 | 记录错误，下次扫描会重试 |
| PR 状态 ≠ reviewing | disband 命令返回错误，不执行解散 |

## 职责边界

- ✅ 检测过期的 PR 审阅讨论
- ✅ 发送解散确认卡片（24h 冷却期）
- ✅ 管理解散流程（群组 + 状态文件 + label）
- ❌ 不创建 PR 审阅（由 pr-scanner/SCHEDULE.md 负责）
- ❌ 不处理 PR 审阅结果（approve/close 由 pr-scanner 处理）
- ❌ 不创建新的 Schedule

## 关联

- Parent: #2210 (PR Scanner v2)
- Depends on: #2219 (scanner.ts), #2220 (SCHEDULE.md + Labels)
- This issue: #2221 (讨论群生命周期管理)
