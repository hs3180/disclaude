---
name: "Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Discussion Lifecycle — 讨论群生命周期管理

自动检测过期的 PR 讨论群，发送解散申请卡片，执行确认后的解散流程。

## 配置

- **状态目录**: `.temp-chats/`
- **扫描间隔**: 每 10 分钟
- **解散申请间隔**: >= 24 小时（同一 PR 不重复发送）
- **仓库**: hs3180/disclaude

## 前置依赖

- `lifecycle.ts`（同目录下）— 生命周期管理 CLI
- `lark-cli`（飞书 CLI）— 群组解散操作
- `gh` CLI — GitHub Label 操作
- `send_interactive` MCP tool — 发送交互式卡片

## 执行步骤

### Step 1: 检查过期 PR

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action check-expired
```

解析输出 JSON:
```json
[
  {
    "prNumber": 123,
    "chatId": "oc_xxx",
    "state": "reviewing",
    "expiresAt": "2026-04-07T10:00:00Z",
    "disbandRequested": null,
    "disbandEligible": true
  }
]
```

**如果列表为空 `[]`，退出本次执行**（无过期 PR）。

### Step 2: 对每个 `disbandEligible=true` 的过期 PR 发送解散申请卡片

对每个过期 PR 且距上次发送 >= 24h（或从未发送）：

**首先确认 state 仍为 `reviewing`**：如果 `state !== "reviewing"`，跳过该 PR（已被其他流程处理）。

使用 `send_interactive` 发送交互式卡片：

```json
{
  "chatId": "{pr.chatId}",
  "title": "⏰ 讨论群即将解散",
  "context": "PR #{pr.prNumber} 的审阅已超时（过期于 {pr.expiresAt}）。\n\n该讨论群即将被解散。如果您仍需要此群聊，请点击「保留群聊」。",
  "question": "请选择操作：",
  "options": [
    { "text": "✅ 确认解散", "value": "confirm_disband", "type": "danger" },
    { "text": "🔄 保留群聊", "value": "keep_group" }
  ],
  "actionPrompts": {
    "confirm_disband": "[用户操作] 用户确认解散 PR #{pr.prNumber} 的讨论群。请执行以下步骤：\n1. 确认 state 仍为 reviewing：`npx tsx schedules/pr-scanner/scanner.ts --action status`\n2. 如果 state ≠ reviewing，告知用户该 PR 已被处理，解散取消\n3. 如果 state = reviewing，执行解散：`npx tsx schedules/discussion-lifecycle/lifecycle.ts --action disband --pr {pr.prNumber}`\n4. 报告执行结果",
    "keep_group": "[用户操作] 用户选择保留 PR #{pr.prNumber} 的讨论群。请确认保留，不做任何操作。下次扫描时如果仍过期会重新提醒。"
  }
}
```

**注意**: 如果 `chatId` 为 null（尚未创建群聊），跳过发送卡片，直接执行解散清理。

### Step 3: 更新 disbandRequested 时间戳

对每个发送了卡片的 PR，更新时间戳（24h 去重）：

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action mark-disband --pr {pr.prNumber}
```

### Step 4: 对于无 chatId 的过期 PR 直接执行清理

如果过期 PR 没有 chatId（从未创建群聊），直接执行清理：

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action disband --pr {pr.prNumber}
```

## 状态转换

| 当前状态 | 条件 | 执行动作 | 结果 |
|----------|------|----------|------|
| `reviewing` (过期) | `disbandEligible=true` | 发送解散申请卡片 | 等待用户确认 |
| `reviewing` (过期) | `disbandEligible=false` | 跳过（24h 内已发送） | 无操作 |
| 用户确认解散 | `state=reviewing` | lark-cli 解散 + 删除状态文件 + 移除 label | 清理完成 |
| 用户确认解散 | `state≠reviewing` | 拒绝解散，告知用户 | 解散取消 |
| 用户保留群聊 | - | 无操作 | 下次扫描会重新提醒 |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `lifecycle.ts` 执行失败 | 记录错误，退出本次执行 |
| `lark-cli` 解散失败 | 仍然删除状态文件（优雅降级） |
| Label 移除失败 | 不阻塞主流程（仅 warn） |
| `send_interactive` 失败 | 回退到 `send_message` 发送纯文本通知 |
| chatId 为 null | 跳过发送卡片，直接清理 |
| state 已非 reviewing | 拒绝解散操作 |

## 不包含

- PR 发现和状态创建（由 pr-scanner/SCHEDULE.md 负责）
- 群聊创建（由 chats-activation schedule 负责）
- 自动解散（需用户确认后才执行）

## 验收标准

- [ ] 过期 PR 被正确识别（now > expiresAt 且 state = reviewing）
- [ ] 解散申请卡片 24h 内不重复发送
- [ ] state ≠ reviewing 时拒绝解散
- [ ] 确认解散后正确清理（群 + 状态文件 + label）
- [ ] 无 chatId 的过期 PR 被直接清理
- [ ] lark-cli 解散失败时仍能删除状态文件（优雅降级）

## 关联

- Parent: #2210
- Depends on: #2219, #2220
- Related: #2221
- Design: docs/designs/pr-scanner-design.md §3.3
