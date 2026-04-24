---
name: "Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Discussion Lifecycle - 讨论群过期与解散管理

定期扫描过期的 PR 讨论群，发送解散申请卡片，管理群组生命周期。

## 配置

- **扫描间隔**: 每 10 分钟
- **解散申请冷却**: 24 小时内不重复发送
- **状态目录**: `.temp-chats/`
- **仓库**: hs3180/disclaude

## 前置依赖

- `schedules/pr-scanner.ts`（状态管理脚本，含 check-expired / mark-disband actions）

## 环境变量

```bash
export PR_SCANNER_REPO="hs3180/disclaude"
```

## 执行步骤

### Step 1: 扫描过期 PR

```bash
npx tsx schedules/pr-scanner.ts --action check-expired
```

解析 JSON 输出（过期的 reviewing 状态 PR 列表）：
```json
[
  {
    "prNumber": 123,
    "chatId": "oc_xxx",
    "state": "reviewing",
    "createdAt": "2026-04-22T10:00:00Z",
    "updatedAt": "2026-04-22T10:00:00Z",
    "expiresAt": "2026-04-24T10:00:00Z",
    "disbandRequested": null
  }
]
```

- 如果返回空数组 `[]`，**退出本次执行**（无过期 PR）

### Step 2: 逐个处理过期 PR

对每个过期 PR 执行以下检查：

#### 2.1 检查解散冷却（24h 去重）

- 如果 `disbandRequested` 不为 `null`，计算距上次发送的时间差：
  - `elapsed = now - disbandRequested`
  - 如果 `elapsed < 24 小时`，**跳过此 PR**（24h 内已发送过）
  - 如果 `elapsed >= 24 小时`，继续发送

- 如果 `disbandRequested` 为 `null`（首次），继续发送

#### 2.2 发送解散申请卡片

使用 `send_interactive` 发送解散确认卡片到讨论群：

```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "⚠️ PR 审阅已过期 — 确认解散?", "tag": "plain_text"}, "template": "orange"},
    "elements": [
      {"tag": "markdown", "content": "**PR #{number}**: {title}\n\n⏰ 审阅已于 `{expiresAt}` 过期（超时 {hours} 小时）\n\n请在下方确认是否解散此讨论群。"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "✅ 确认解散", "tag": "plain_text"}, "value": "confirm_disband", "type": "primary"},
        {"tag": "button", "text": {"content": "🔄 继续审阅", "tag": "plain_text"}, "value": "continue_review"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "{chatId or fallback chatId}",
  "actionPrompts": {
    "confirm_disband": "[用户操作] 用户确认解散 PR #{number} 的讨论群。请执行：\n1. 验证 state 仍为 reviewing：`npx tsx schedules/pr-scanner.ts --action status`\n2. 如果 state ≠ reviewing，回复「该 PR 状态已变更，无法解散」并退出\n3. 如果 state = reviewing，执行解散：\n   a. `npx tsx schedules/pr-scanner.ts --action mark --pr {number} --state closed`\n   b. 如果 chatId 不为 null，使用 lark-cli 解散群组\n   c. 删除状态文件（如需要）\n4. 报告结果",
    "continue_review": "[用户操作] 用户选择继续审阅 PR #{number}。请回复「已取消解散，请尽快完成审阅」。"
  }
}
```

**注意**:
- 将 `{number}`、`{title}`、`expiresAt}`、`{hours}` 替换为实际值
- `hours` = `Math.floor((now - expiresAt) / 3600000)`
- 如果 `chatId` 为 null，发送到本 schedule 配置的 `chatId` 作为兜底

#### 2.3 更新 disbandRequested 时间戳

发送卡片后，立即更新时间戳：

```bash
npx tsx schedules/pr-scanner.ts --action mark-disband --pr {number}
```

此操作会将 `disbandRequested` 更新为当前时间，确保 24h 内不会重复发送。

## 解散确认流程

当用户点击「确认解散」按钮时：

### 1. 验证 PR 状态

```bash
npx tsx schedules/pr-scanner.ts --action status
```

- 检查该 PR 的 `state` 是否仍为 `reviewing`
- 如果 `state ≠ reviewing`（已被用户处理），**拒绝解散**并回复状态

### 2. 执行解散

```bash
# 标记状态为 closed
npx tsx schedules/pr-scanner.ts --action mark --pr {number} --state closed

# 解散群组（如果 chatId 不为 null）
# 使用 lark-cli 或对应平台的群组解散功能
```

### 3. 清理

- `mark --state closed` 会自动移除 `pr-scanner:reviewing` GitHub Label（best-effort）
- 状态文件保留（state: closed）用于审计

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `check-expired` 返回空 | 退出本次执行 |
| `disbandRequested` 24h 内已发送 | 跳过该 PR |
| `send_interactive` 失败 | 记录错误，下次重试 |
| `mark-disband` 失败 | 记录错误，下次重试 |
| 解散时 state ≠ reviewing | 拒绝解散，提示当前状态 |
| lark-cli 解散失败 | 记录错误，状态已标记 closed |

## 注意事项

1. **24h 去重**: 通过 `disbandRequested` 时间戳确保不重复打扰
2. **幂等性**: `mark-disband` 可以重复调用，只更新时间戳
3. **不自动解散**: 必须用户点击确认按钮后才执行解散
4. **不创建新 Schedule**: 定时任务执行规则
5. **不修改其他文件**: 只操作 `.temp-chats/` 下的状态文件

## 依赖

- `gh` CLI
- `schedules/pr-scanner.ts`（状态管理脚本，含 Phase 2 lifecycle actions）
- MCP Tool: `send_interactive`（发送交互式卡片）
- GitHub Label: `pr-scanner:reviewing`

## 关联

- Parent: #2210
- Depends on: #2219, #2220
- Implements: #2221
- Design: docs/designs/pr-scanner-design.md §3.3
