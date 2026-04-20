---
name: "Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Discussion Lifecycle — PR 讨论群过期和解散管理

自动扫描 `.temp-chats/` 中的过期 PR，发送解散申请卡片，并在确认后执行解散。

## 配置

- **状态目录**: `.temp-chats/`
- **执行间隔**: 每 10 分钟
- **解散去重**: 24 小时内不重复发送解散申请卡片
- **仓库**: `hs3180/disclaude`

## 前置依赖

- `@larksuite/cli`（飞书官方 CLI，用于群解散）
- `gh` CLI（用于 GitHub Label 操作）
- PR Scanner Sub-Issue A (#2219): `scanner.ts` 基础脚本
- PR Scanner Sub-Issue B (#2220): `SCHEDULE.md` + 通知流程

## 职责边界

- ✅ 检测过期 PR（`now > expiresAt` 且 `state === reviewing`）
- ✅ 发送解散申请卡片（24h 去重）
- ✅ 执行确认解散（lark-cli 群解散 + 状态清理 + Label 移除）
- ✅ 拒绝非 reviewing 状态的解散请求
- ❌ 不发送初始 PR 通知（由 pr-scanner schedule 负责）
- ❌ 不创建讨论群（由 pr-scanner schedule 负责）

## 执行步骤

### Step 1: 扫描过期 PR

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action check-expired --dedup-hours 24
```

输出 JSON 格式:
```json
{
  "needsDisband": [
    {
      "prNumber": 123,
      "chatId": "oc_xxx",
      "expiresAt": "2026-04-20T10:00:00Z",
      "disbandRequested": null,
      "filePath": ".temp-chats/pr-123.json"
    }
  ],
  "alreadyNotified": [
    {
      "prNumber": 456,
      "chatId": "oc_yyy",
      "expiresAt": "2026-04-19T10:00:00Z",
      "disbandRequested": "2026-04-19T12:00:00Z",
      "filePath": ".temp-chats/pr-456.json"
    }
  ]
}
```

### Step 2: 对 needsDisband 中的 PR 发送解散申请卡片

对每个 `needsDisband` 中的 PR：

#### 2a. 前置检查 — 确认 PR state 仍为 reviewing

读取状态文件，确认 `state === 'reviewing'`。如果不是 `reviewing`，跳过该 PR。

#### 2b. 发送解散申请卡片

使用 `send_interactive` 向讨论群（`chatId`）发送交互式卡片：

```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "⏰ PR 讨论群即将解散", "tag": "plain_text"}, "template": "orange"},
    "elements": [
      {"tag": "markdown", "content": "PR #{prNumber} 的讨论群已超过有效期（过期于 {expiresAt}）。"},
      {"tag": "markdown", "content": "如无需要，请确认解散。如需继续讨论，请忽略此消息。"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "✅ 确认解散", "tag": "plain_text"}, "value": "confirm-disband-{prNumber}", "type": "danger"},
        {"tag": "button", "text": {"content": "⏳ 继续讨论", "tag": "plain_text"}, "value": "keep-discussing-{prNumber}"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "{chatId}",
  "actionPrompts": {
    "confirm-disband-{prNumber}": "[用户操作] 用户确认解散 PR #{prNumber} 讨论群。请执行：\n1. 运行 `npx tsx schedules/discussion-lifecycle/lifecycle.ts --action execute-disband --pr {prNumber}`\n2. 报告执行结果",
    "keep-discussing-{prNumber}": "[用户操作] 用户选择继续讨论 PR #{prNumber}。无需操作，下次扫描将再次提醒。"
  }
}
```

如果 PR 没有 `chatId`（Phase 1 回退场景），跳过发送卡片。

#### 2c. 更新 disbandRequested 时间戳

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action mark-disband --pr {prNumber}
```

### Step 3: 对 alreadyNotified 中的 PR 跳过

已在 24h 内发送过解散申请卡片的 PR 不重复发送。仅在日志中记录：
```
INFO: PR #{prNumber} 已在 {disbandRequested} 发送过解散申请，跳过
```

## 确认解散流程

当用户点击「确认解散」按钮时，由 actionPrompt 触发执行：

### 1. 执行解散

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action execute-disband --pr {prNumber}
```

该命令会：
1. 验证 PR state 仍为 `reviewing`（如果不是，拒绝解散）
2. 通过 lark-cli 解散群组（`DELETE /open-apis/im/v1/chats/{chatId}`）
3. 更新状态为 `closed`
4. 移除 GitHub PR 上的 `pr-scanner:reviewing` label
5. 删除状态文件

### 2. 报告结果

根据 execute-disband 的输出报告结果：
- `{ "success": true }` → "PR #{prNumber} 讨论群已解散并清理完成"
- `{ "success": false, "action": "reject" }` → "PR #{prNumber} 状态不是 reviewing，拒绝解散"
- `{ "success": false, "action": "skip" }` → "PR #{prNumber} 状态文件不存在或已损坏"

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| lark-cli 不可用 | 跳过群解散，但仍然更新状态和清理 label |
| 群解散失败 | 记录警告，继续更新状态（群可能已被手动解散） |
| GitHub Label 移除失败 | 记录警告，不阻塞主流程 |
| 状态文件损坏 | 跳过该文件 |
| 非 reviewing 状态的解散请求 | 拒绝执行 |
| 无 chatId 的 PR | 跳过发送卡片（Phase 1 回退场景） |

## 状态转换

| 当前状态 | 条件 | 执行动作 | 新状态 |
|----------|------|----------|--------|
| `reviewing` | `expiresAt` 已过期 且 未发送过卡片 | 发送解散申请卡片 + 更新 disbandRequested | `reviewing`（等待确认） |
| `reviewing` | `expiresAt` 已过期 且 24h 内已发送卡片 | 跳过（等待用户响应或下次提醒） | `reviewing` |
| `reviewing` | 用户确认解散 | lark-cli 解散 + 移除 label + 删除文件 | `closed`（文件已删除） |
| 非 `reviewing` | 收到解散请求 | 拒绝解散 | 不变 |

## 注意事项

1. **幂等性**: disbandRequested 时间戳确保不重复发送卡片
2. **状态校验**: 执行解散前必须确认 state 仍为 reviewing
3. **有限处理**: 每次扫描处理所有过期 PR（无上限，因为数量有限）
4. **安全清理**: 即使 lark-cli 解散失败也继续清理状态
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只处理 `.temp-chats/` 目录下的文件

## 验收标准

- [ ] 过期 PR 被正确识别
- [ ] 解散申请卡片 24h 内不重复发送
- [ ] state ≠ reviewing 时拒绝解散
- [ ] 确认解散后正确清理（群 + 状态文件 + label）
