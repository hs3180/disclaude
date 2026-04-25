---
name: "Discussion Lifecycle Manager"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Discussion Lifecycle Manager — Schedule Prompt

定期扫描 `.temp-chats/` 中过期的 PR 讨论群，发送解散申请卡片并管理群生命周期。

## 配置

- **扫描间隔**: 每 10 分钟
- **过期时间**: 48 小时（state file `expiresAt`）
- **解散通知间隔**: 24 小时（不重复发送）
- **脚本路径**: `schedules/discussion-lifecycle/lifecycle.ts`
- **Scanner 脚本路径**: `schedules/pr-scanner/scanner.ts`

## 执行步骤

### Step 1: 检查过期 PR

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action check-expired
```

解析输出 JSON（过期 PR 列表）：
```json
[
  {
    "prNumber": 123,
    "chatId": "oc_xxx",
    "state": "reviewing",
    "expiredAt": "2026-04-23T10:00:00.000Z",
    "disbandRequested": null,
    "hoursSinceExpiry": 24.5,
    "hoursSinceDisband": null,
    "needsDisbandNotification": true
  }
]
```

如果列表为空 `[]`，**退出本次执行**（无过期 PR）。

### Step 2: 遍历过期 PR

对每个过期 PR，按以下逻辑处理：

#### 2a. 检查 PR 状态

如果 `state !== "reviewing"`，**跳过该 PR**（已处理完成，等待清理）。

如果 `state === "reviewing"` 且 `needsDisbandNotification === true`：

#### 2b. 发送解散申请卡片

使用 `send_interactive` 发送交互式卡片到讨论群：

```json
{
  "chatId": "{chatId 或 admin chatId}",
  "title": "⏰ PR #{prNumber} 讨论群即将解散",
  "question": "该 PR 的审阅时间已过期 {hoursSinceExpiry} 小时。\n\n| 属性 | 值 |\n|------|-----|\n| PR 编号 | #{prNumber} |\n| 过期时间 | {expiredAt} |\n| 已过期 | {hoursSinceExpiry} 小时 |\n\n请选择操作：",
  "options": [
    { "text": "✅ 确认解散", "value": "confirm_disband", "type": "primary" },
    { "text": "⏳ 延长审阅", "value": "extend_review", "type": "default" }
  ],
  "actionPrompts": {
    "confirm_disband": "[用户操作] 用户确认解散 PR #{prNumber} 的讨论群。请执行以下步骤：\n1. 确认 state === 'reviewing'（如不是则拒绝）\n2. 执行 lark-cli 解散讨论群\n3. 执行 `npx tsx schedules/discussion-lifecycle/lifecycle.ts --action cleanup --pr {prNumber}`\n4. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action remove-label --pr {prNumber}`\n5. 报告执行结果",
    "extend_review": "[用户操作] 用户请求延长 PR #{prNumber} 的审阅时间。请执行以下步骤：\n1. 询问用户需要延长多少时间（默认 24 小时）\n2. 更新 state file 的 expiresAt\n3. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {prNumber} --state reviewing`\n4. 报告新的过期时间"
  }
}
```

如果 `chatId` 为 null（Phase 1 回退），使用 admin chatId `oc_71e5f41a029f3a120988b7ecb76df314`。

#### 2c. 标记已发送解散通知

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action mark-disband --pr {prNumber}
```

此操作更新 `disbandRequested` 时间戳，确保 24 小时内不重复发送。

### Step 3: 清理已完成但未删除的状态文件

对于 `state !== "reviewing"`（即 approved 或 closed）且已过期的 PR，执行清理：

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action cleanup --pr {prNumber}
```

然后移除 GitHub Label：

```bash
npx tsx schedules/pr-scanner/scanner.ts --action remove-label --pr {prNumber}
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| lifecycle.ts 执行失败 | 记录错误，退出本次执行 |
| `send_interactive` 失败 | 回退使用 `send_message` 发送纯文本通知 |
| `mark-disband` 失败 | 记录错误，跳过该 PR，下次重试 |
| `cleanup` 失败 | 记录错误，跳过该 PR |
| lark-cli 解散失败 | 记录错误，不清理状态文件（下次重试） |
| Label 操作失败 | 忽略，不阻塞主流程 |

## 注意事项

1. **24 小时间隔**: `needsDisbandNotification` 确保不重复发送解散通知
2. **state 检查**: 只对 `state === "reviewing"` 的过期 PR 发送解散通知
3. **Phase 1 回退**: 如果 `chatId` 为 null，使用 admin chatId
4. **幂等性**: `mark-disband` 可安全重复调用，只更新时间戳
5. **串行处理**: 逐个处理过期 PR，避免并发问题
6. **已处理 PR 清理**: `state !== reviewing` 的过期 PR 直接清理

## 依赖

- `npx tsx` — 运行 lifecycle.ts 和 scanner.ts
- `gh` CLI — GitHub Label 操作
- `send_interactive` MCP 工具 — 发送交互式卡片
- `send_message` MCP 工具 — 备用纯文本通知
- `lark-cli` — 讨论群解散（确认解散后）

## 相关

- Issue #2221 (本 Schedule + lifecycle.ts)
- Issue #2219 (scanner.ts 基础骨架)
- Issue #2220 (PR Scanner SCHEDULE.md)
- Issue #2210 (PR Scanner v2 父 Issue)
- Issue #1547 (临时会话管理 Schedule 集成)
