---
name: "PR Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_ADMIN_CHAT_ID"
createdAt: "2026-04-20T00:00:00.000Z"
---

# PR Discussion Lifecycle — Schedule Prompt

管理 PR 讨论群的生命周期：检测过期讨论、发送解散申请卡片、执行清理。

## 配置

- **扫描间隔**: 每 10 分钟
- **状态目录**: `.temp-chats/`（可通过 `PR_SCANNER_DIR` 环境变量覆盖）
- **解散通知间隔**: 24 小时（不重复发送）
- **状态过期**: 48 小时（由 scanner.ts create-state 设置）

## 前置依赖

- `npx tsx`（运行 lifecycle.ts）
- `lark-cli`（飞书群操作，解散群聊）
- `gh` CLI（GitHub Label 管理）
- Sub-Issue A (#2219) scanner.ts 基础脚本
- Sub-Issue B (#2220) SCHEDULE.md + 通知流程

## 执行步骤

### Step 1: 检测过期讨论

```bash
npx tsx schedules/pr-scanner/lifecycle.ts --action check-expired
```

解析 JSON 输出。如果返回空数组，**退出本次执行**（无过期讨论）。

### Step 2: 发送解散申请卡片

对每个 `shouldNotify === true` 的过期 PR：

**前置检查**：
- 验证 `state` 仍为 `reviewing`（非 reviewing 状态拒绝解散）
- 如果 `chatId` 为 null，跳过该 PR（无法发送到群聊）

使用 `send_interactive`（format: "card"）发送解散申请卡片到讨论群：

**卡片内容**:
```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"content": "⏰ 讨论已过期 — PR #{number}", "tag": "plain_text"},
    "template": "orange"
  },
  "elements": [
    {"tag": "markdown", "content": "该 PR 的讨论群已超过有效期限（48 小时）。\n\n| 属性 | 值 |\n|------|-----|\n| PR 编号 | #{number} |\n| 过期时间 | {expiresAt} |\n| 创建时间 | {createdAt} |\n\n请选择处理方式："},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ 确认解散", "tag": "plain_text"}, "value": "confirm-disband-{number}", "type": "primary"},
      {"tag": "button", "text": {"content": "⏳ 续期 24h", "tag": "plain_text"}, "value": "extend-disband-{number}"},
      {"tag": "button", "text": {"content": "❌ 取消", "tag": "plain_text"}, "value": "cancel-disband-{number}", "type": "danger"}
    ]},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "24 小时内不会重复发送此通知"}
    ]}
  ]
}
```

**actionPrompts**:
```json
{
  "confirm-disband-{number}": "[用户操作] 用户确认解散 PR #{number} 的讨论群。请执行以下步骤：\n1. 验证 PR #{number} 的 state 仍为 reviewing（运行 `npx tsx schedules/pr-scanner/lifecycle.ts --action check-expired` 检查）\n2. 如果 state ≠ reviewing，拒绝解散并说明原因\n3. 如果 state = reviewing，执行解散流程（Step 3）",
  "extend-disband-{number}": "[用户操作] 用户选择续期 PR #{number} 的讨论群。请执行以下步骤：\n1. 更新 expiresAt：运行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {number} --state reviewing`（保持 reviewing 不变，updatedAt 已更新）\n2. 报告续期结果",
  "cancel-disband-{number}": "[用户操作] 用户取消解散 PR #{number} 的讨论群。无需额外操作，下次扫描时会重新检测。"
}
```

### Step 3: 记录解散通知

对已发送通知的 PR，更新 `disbandRequested` 时间戳：

```bash
npx tsx schedules/pr-scanner/lifecycle.ts --action mark-disband --pr {number}
```

### Step 4: 执行解散（用户确认后）

当用户点击「确认解散」按钮时，AI Agent 执行以下流程：

#### 4.1 验证 state

```bash
npx tsx schedules/pr-scanner/lifecycle.ts --action check-expired
```

确认目标 PR 的 state 仍为 `reviewing`。如果 `≠ reviewing`，拒绝解散并通知用户。

#### 4.2 解散群聊

```bash
lark-cli im +chat-disband --chat-id {chatId}
```

如果解散失败（如群已不存在），记录警告但继续清理流程。

#### 4.3 清理状态

```bash
npx tsx schedules/pr-scanner/lifecycle.ts --action cleanup --pr {number}
```

此命令会：
1. 删除 `.temp-chats/pr-{number}.json` 状态文件
2. 移除 GitHub `pr-scanner:reviewing` label（best-effort）

## 状态管理

### 解散通知去重

- `disbandRequested` 字段记录最后一次发送解散通知的时间
- 24 小时内不会重复发送（`shouldNotify === false`）
- 如果用户选择续期，`disbandRequested` 会在下次过期时重置

### 解散前验证

```
检测到过期 PR → 发送解散卡片 → 用户确认 → 验证 state
  ├─ state = reviewing → 解散群聊 → 删除状态文件 → 移除 label
  └─ state ≠ reviewing → 拒绝解散，说明状态已变更
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `lifecycle.ts` 执行失败 | 记录错误，退出本次执行 |
| `send_interactive` 失败 | 记录错误，PR 仍处于 tracking 状态 |
| `lark-cli disband` 失败 | 记录警告，继续清理状态文件和 label |
| Label 移除失败 | 记录警告，不阻塞主流程 |
| 状态文件删除失败 | 记录错误，手动清理 |
| chatId 为 null | 跳过该 PR（无法发送到群聊） |

## 注意事项

1. **只处理 reviewing 状态**: 只有 state=reviewing 的 PR 会被纳入生命周期管理
2. **24h 去重**: 解散通知不会在 24 小时内重复发送
3. **验证后执行**: 解散前必须再次验证 state 仍为 reviewing
4. **Best-effort 清理**: 群解散和 label 移除失败不阻塞状态文件清理
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只操作 `.temp-chats/` 目录和 GitHub Label

## 验收标准

- [ ] 过期 PR 被正确识别（now > expiresAt && state = reviewing）
- [ ] 解散申请卡片 24h 内不重复发送
- [ ] state ≠ reviewing 时拒绝解散
- [ ] 确认解散后正确清理（群 + 状态文件 + label）
- [ ] lifecycle.ts 输出 JSON 可被 AI Agent 解析
- [ ] `send_interactive` 卡片按钮可点击并触发正确 actionPrompt
