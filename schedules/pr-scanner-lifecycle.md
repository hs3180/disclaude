---
name: "PR Scanner Lifecycle"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# PR Scanner Lifecycle — 讨论群过期与解散管理

管理 PR Scanner 创建的讨论群组生命周期：检测过期 PR、发送解散确认卡片、执行解散清理。

## 配置

- **状态目录**: `.temp-chats/`（`PR_SCANNER_STATE_DIR` 环境变量可覆盖）
- **解散冷却**: 24 小时（`LIFECYCLE_DISBAND_COOLDOWN_HOURS` 环境变量可覆盖）
- **扫描间隔**: 每 10 分钟

## 前置依赖

- `npx tsx`（运行 pr-scanner-lifecycle.ts）
- `lark-cli`（解散群组时需要）
- PR Scanner Phase 1 已创建的状态文件（`.temp-chats/pr-{number}.json`）

## 职责边界

- ✅ 检测过期的 reviewing PR（now > expiresAt）
- ✅ 发送解散申请卡片（24h 冷却，不重复发送）
- ✅ 验证 PR 状态后执行解散
- ✅ 清理状态文件和 GitHub Label
- ❌ 不创建新的讨论群（由 PR Scanner Phase 1 负责）
- ❌ 不处理 active/approved/closed 状态的 PR
- ❌ 不修改 PR 本身（不解散非 reviewing 的群）

## 执行步骤

### Step 1: 检查过期 PR

```bash
npx tsx scripts/schedule/pr-scanner-lifecycle.ts check-expired
```

解析 JSON 输出（数组）：
```json
[
  {
    "prNumber": 1234,
    "chatId": "oc_xxxx",
    "state": "reviewing",
    "expiresAt": "2026-04-08T12:00:00Z",
    "disbandRequested": null,
    "needsDisband": true
  }
]
```

**判断**:
- 如果数组为空，跳过本次执行，输出「无过期 PR」。
- 只处理 `needsDisband === true` 的条目（已过滤 24h 冷却）。

### Step 2: 发送解散申请卡片

对每个 `needsDisband === true` 的过期 PR，检查 `state === reviewing`：
- **state ≠ reviewing** → 跳过（PR 状态已变更，不应解散）
- **state === reviewing** → 发送解散确认卡片

使用 `send_interactive` 发送到 admin chatId：

**卡片内容**（format: "card"）：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "⏰ PR #{prNumber} 已过期，确认解散？", "tag": "plain_text"}, "template": "orange"},
  "elements": [
    {"tag": "markdown", "content": "**PR #{prNumber}** 已超过 48 小时审查期限。\n\n| 属性 | 值 |\n|------|-----|\n| 🕐 过期时间 | {expiresAt} |\n| 📊 当前状态 | {state} |\n| 💬 讨论群 | {chatId ?? '未创建'} |\n| 🔔 上次提醒 | {disbandRequested ?? '无'} |"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ 确认解散", "tag": "plain_text"}, "value": "confirm_disband", "type": "primary"},
      {"tag": "button", "text": {"content": "❌ 取消", "tag": "plain_text"}, "value": "cancel_disband"}
    ]},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "确认后将解散讨论群、清理状态文件、移除 reviewing label"}
    ]}
  ]
}
```

**actionPrompts**：
```json
{
  "confirm_disband": "[用户操作] 用户确认解散 PR #{prNumber} 的讨论群。请执行以下步骤：\n1. 运行 `npx tsx scripts/schedule/pr-scanner-lifecycle.ts mark-disband --pr {prNumber}` 记录时间戳\n2. 检查 state 是否仍为 reviewing（非 reviewing 则拒绝解散并告知用户）\n3. 若有 chatId，执行 `lark-cli api DELETE /open-apis/im/v1/chats/{chatId}` 解散群组\n4. 执行 `npx tsx scripts/schedule/pr-scanner.ts remove-label --pr {prNumber} --label pr-scanner:reviewing` 移除 GitHub label\n5. 执行 `npx tsx scripts/schedule/pr-scanner.ts mark --pr {prNumber} --state closed` 更新状态\n6. 删除状态文件 `.temp-chats/pr-{prNumber}.json`\n7. 报告执行结果",
  "cancel_disband": "[用户操作] 用户取消解散 PR #{prNumber}。运行 `npx tsx scripts/schedule/pr-scanner-lifecycle.ts mark-disband --pr {prNumber}` 记录时间戳（24h 内不会再次提醒）。告知用户已取消，24 小时后会再次询问。"
}
```

### Step 3: 记录提醒时间戳

发送卡片后，对每个已发送的 PR 记录 disband 时间戳：

```bash
npx tsx scripts/schedule/pr-scanner-lifecycle.ts mark-disband --pr {prNumber}
```

## 状态转换

| 条件 | 动作 | 结果 |
|------|------|------|
| `state=reviewing` + `expiresAt < now` + `disbandRequested=null` | 发送解散卡片 | 等待用户确认 |
| `state=reviewing` + `expiresAt < now` + `disbandRequested >= 24h` | 再次发送解散卡片 | 等待用户确认 |
| `state=reviewing` + `expiresAt < now` + `disbandRequested < 24h` | 跳过（冷却中） | 无操作 |
| `state≠reviewing` | 跳过 | 无操作 |
| 用户确认解散 | 解散群 + 删除文件 + 移除 label | PR 归档 |
| 用户取消解散 | 记录时间戳 | 24h 后重试 |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 状态目录不存在 | 正常退出（无过期 PR） |
| 状态文件损坏 | 跳过并记录警告 |
| lark-cli 不可用 | 记录错误，仍更新时间戳（下次重试） |
| 群组解散失败 | 记录警告，继续后续清理（群可能已解散） |
| GitHub label 移除失败 | 记录警告（不影响主流程） |

## 注意事项

1. **幂等性**: `mark-disband` 只更新时间戳，重复执行安全
2. **24h 冷却**: 解散卡片不会重复发送（基于 `disbandRequested` 时间戳）
3. **状态检查**: 确认解散前必须验证 state 仍为 reviewing
4. **串行处理**: 一次处理一个过期 PR，避免并发问题
5. **安全解散**: 只解散 reviewing 状态的群，避免误操作

## 验收标准

- [ ] 过期 PR 被正确识别（state=reviewing 且 expiresAt < now）
- [ ] 解散申请卡片 24h 内不重复发送
- [ ] state ≠ reviewing 时拒绝解散
- [ ] 确认解散后正确清理（群 + 状态文件 + label）
