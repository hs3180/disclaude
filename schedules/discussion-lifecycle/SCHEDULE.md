---
name: "Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Discussion Lifecycle — PR 讨论群过期管理

自动扫描过期的 reviewing PR 讨论群，发送解散确认卡片，并执行解散清理。

## 配置

- **状态目录**: `.temp-chats/`
- **扫描间隔**: 每 10 分钟
- **解散申请冷却**: 24 小时（同一 PR 24h 内不重复发送解散申请）

## 前置依赖

- `@larksuite/cli`（飞书官方 CLI，用于解散群组）
- `schedules/pr-scanner.ts`（scanner 基础脚本，提供 check-expired / mark-disband action）
- MCP Tool: `send_interactive`

## 执行步骤

### Step 1: 扫描过期的 reviewing PR

```bash
npx tsx schedules/pr-scanner.ts --action check-expired
```

解析输出 JSON 数组。每个元素包含：
- `prNumber`: PR 编号
- `chatId`: 讨论群 chatId（可能为 null）
- `expiresAt`: 过期时间
- `disbandRequested`: 上次发送解散申请的时间戳（ISO string 或 false）

如果输出为空数组 `[]`，输出 "Discussion Lifecycle: 无过期 PR" 并退出。

### Step 2: 过滤需要发送解散申请的 PR

对每个过期 PR，检查解散申请冷却：

- `disbandRequested === false` → **需要发送**（从未发送过）
- `disbandRequested` 为 ISO 时间戳 且 `now - disbandRequested >= 24h` → **需要发送**
- `disbandRequested` 为 ISO 时间戳 且 `now - disbandRequested < 24h` → **跳过**（24h 内已发送）

对跳过的 PR，输出 `INFO: PR #{prNumber} 解散申请已在 24h 内发送，跳过`。

### Step 3: 发送解散确认卡片

对每个需要发送解散申请的 PR（且 `chatId` 不为 null），使用 `send_interactive` 发送解散确认卡片：

**聊天指定**: 使用 PR 状态文件中的 `chatId` 作为目标聊天。

**卡片内容**（format: "card"）：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "⚠️ 讨论群即将解散", "tag": "plain_text"}, "template": "orange"},
  "elements": [
    {"tag": "markdown", "content": "PR #{number} 的讨论群已超过有效期（过期时间: {expiresAt}）。\n\n请确认是否解散此讨论群？"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ 确认解散", "tag": "plain_text"}, "value": "confirm_disband_{number}", "type": "primary"},
      {"tag": "button", "text": {"content": "⏳ 继续讨论", "tag": "plain_text"}, "value": "keep_discuss_{number}"}
    ]}
  ]
}
```

**actionPrompts**：

```json
{
  "confirm_disband_{number}": "[用户操作] 用户确认解散 PR #{number} 的讨论群。请执行以下步骤：\n1. 重新读取状态文件检查 state 是否仍为 reviewing（`npx tsx schedules/pr-scanner.ts --action status` 后确认 PR #{number} 的 state）\n2. 如果 state ≠ reviewing，拒绝解散并告知用户（'该 PR 已不在 reviewing 状态，无需解散'）\n3. 如果 state = reviewing，执行解散流程（Step 4）\n4. 报告执行结果",
  "keep_discuss_{number}": "[用户操作] 用户选择继续讨论 PR #{number}。将 PR #{number} 的 disbandRequested 重置为 false（避免下次扫描重复发送）。执行 `npx tsx schedules/pr-scanner.ts --action mark-disband --pr {number}` 但先手动将 disbandRequested 重置为 false — 注意：实际上这意味着不需要重置，只需记录用户选择继续讨论即可。"
}
```

> **注意**: `keep_discuss` 按钮仅作为用户意图表达，不改变状态文件。下次扫描时（24h 后）仍会发送解散申请。如果用户不希望解散，应该通过 Approve/Close PR 来改变状态。

### Step 4: 更新 disbandRequested 时间戳

对已发送解散申请卡片的 PR，更新时间戳：

```bash
npx tsx schedules/pr-scanner.ts --action mark-disband --pr {number}
```

此操作将 `disbandRequested` 更新为当前时间，防止 24h 内重复发送。

### Step 5: 用户确认解散后的执行流程

当用户点击"确认解散"按钮后，执行以下步骤：

#### 5.1 检查 PR state

```bash
npx tsx schedules/pr-scanner.ts --action status
```

确认目标 PR 的 state 仍为 `reviewing`：
- **state ≠ reviewing** → 拒绝解散，告知用户 "该 PR 已不在 reviewing 状态，无需解散讨论群"
- **state = reviewing** → 继续执行

#### 5.2 解散群组

通过 lark-cli 解散讨论群：

```bash
lark-cli api DELETE "/open-apis/im/v1/chats/{chatId}"
```

如果 lark-cli 不可用或解散失败，记录警告但继续执行后续清理（群可能已被手动解散）。

#### 5.3 删除状态文件

```bash
rm .temp-chats/pr-{number}.json
```

#### 5.4 移除 reviewing label

```bash
npx tsx schedules/pr-scanner.ts --action remove-label --pr {number}
```

Label 移除失败不阻塞流程。

#### 5.5 报告结果

告知用户解散完成：
- "✅ PR #{number} 讨论群已解散，状态文件已清理，reviewing label 已移除"

## 状态管理

### disbandRequested 状态转换

| 当前值 | 条件 | 动作 | 新值 |
|--------|------|------|------|
| `false` | 过期 PR | 发送解散申请卡片 | ISO 时间戳 |
| ISO 时间戳 | 距上次 >= 24h | 发送解散申请卡片 | 新 ISO 时间戳 |
| ISO 时间戳 | 距上次 < 24h | 跳过 | 不变 |

### 解散后清理

| 操作 | 说明 |
|------|------|
| 解散群组 | lark-cli DELETE API |
| 删除状态文件 | `rm .temp-chats/pr-{number}.json` |
| 移除 reviewing label | scanner.ts remove-label |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| scanner.ts 执行失败 | 记录错误，退出本次执行 |
| `chatId` 为 null | 跳过发送卡片，仅更新 disbandRequested |
| send_interactive 失败 | 状态文件已更新，下次不重复（24h 冷却） |
| lark-cli 不可用 | 记录警告，继续后续清理 |
| 解散群组失败 | 记录警告（群可能已被解散），继续清理 |
| label 移除失败 | 不阻塞，记录警告 |
| state 已非 reviewing | 拒绝解散，告知用户 |

## 验收标准

- [ ] 过期 PR 被正确识别（state=reviewing 且 now > expiresAt）
- [ ] 解散申请卡片 24h 内不重复发送
- [ ] state ≠ reviewing 时拒绝解散
- [ ] 确认解散后正确清理（群 + 状态文件 + label）

## 关联

- Parent: #2210
- Depends on: #2219, #2220
- Related: #2221
