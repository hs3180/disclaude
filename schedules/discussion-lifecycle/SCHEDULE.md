---
name: "Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Discussion Lifecycle — 讨论群过期与解散管理

管理 PR Scanner 创建的讨论群的生命周期：检测过期讨论群，发送解散申请卡片，执行确认后的解散操作。

## 配置

- **状态目录**: `.temp-chats/`
- **扫描间隔**: 每 10 分钟
- **解散通知冷却**: 24 小时（同一 PR 24h 内不重复发送解散通知）
- **仓库**: hs3180/disclaude

## 前置依赖

- `lifecycle.ts` CLI（本目录下）
- `gh` CLI（GitHub Label 管理）
- `lark-cli`（飞书群组操作，可选 — 不可用时仅清理状态文件）

## 职责边界

- ✅ 检测过期的 reviewing PR（`now > expiresAt`）
- ✅ 向讨论群发送解散申请卡片（24h 冷却）
- ✅ 确认解散后：lark-cli 解散群 + 删除状态文件 + 移除 GitHub Label
- ✅ 拒绝非 reviewing 状态的解散请求
- ❌ 不创建新讨论群（由 `pr-scanner` schedule 负责）
- ❌ 不处理 PR 合并/关闭操作（由用户在讨论群中触发）

## 执行步骤

### Step 1: 检测过期 PR

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action check-expired
```

解析返回的 JSON 数组。如果返回空数组 `[]`，**退出本次执行**。

每项包含：
- `prNumber` — PR 编号
- `chatId` — 讨论群 ID
- `expiresAt` — 过期时间
- `disbandRequested` — 上次发送解散通知的时间（null 表示未发送过）
- `shouldNotify` — 是否需要发送新的解散通知（24h 冷却检查）

### Step 2: 对需要通知的 PR 发送解散申请卡片

遍历 Step 1 的结果，对 `shouldNotify === true` 的 PR：

使用 `send_interactive` 发送到 `{chatId}`：

**卡片内容**（format: "card"）：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "⏰ 讨论已过期 — PR #{number}", "tag": "plain_text"}, "template": "orange"},
  "elements": [
    {"tag": "markdown", "content": "该 PR 的讨论群已超过有效期（过期时间: {expiresAt}）。\n\n请确认是否解散此讨论群。"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ 确认解散", "tag": "plain_text"}, "value": "confirm_disband", "type": "primary"},
      {"tag": "button", "text": {"content": "🔄 继续讨论", "tag": "plain_text"}, "value": "keep_discussing"}
    ]}
  ]
}
```

**actionPrompts**：
```json
{
  "confirm_disband": "[用户操作] 用户确认解散 PR #{number} 的讨论群。请执行以下步骤：\n1. 执行 `npx tsx schedules/discussion-lifecycle/lifecycle.ts --action confirm-disband --pr {number} --repo hs3180/disclaude`\n2. 报告执行结果（成功/失败）",
  "keep_discussing": "[用户操作] 用户选择继续讨论 PR #{number}。此讨论群将保留，下次过期检测时会再次提醒。"
}
```

### Step 3: 更新通知时间戳

发送解散通知后，更新 `disbandRequested` 时间戳：

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action mark-disband --pr {number}
```

这确保 24h 内不会重复发送解散通知。

### Step 4: 处理用户确认解散

当用户在讨论群中点击"确认解散"按钮时，action prompt 触发执行：

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action confirm-disband --pr {number} --repo hs3180/disclaude
```

此命令会：
1. **验证状态** — 检查 PR 当前是否为 `reviewing`，非 reviewing 则拒绝解散
2. **移除 GitHub Label** — `gh pr edit {number} --remove-label pr-scanner:reviewing`
3. **解散群组** — `lark-cli api DELETE /open-apis/im/v1/chats/{chatId}`
4. **删除状态文件** — 移除 `.temp-chats/pr-{number}.json`

任何步骤失败都会记录错误，但不阻塞后续步骤的执行。

## 状态转换

| 当前状态 | 条件 | 动作 | 结果 |
|----------|------|------|------|
| `reviewing` | `now > expiresAt` + `shouldNotify` | 发送解散卡片 + 更新 disbandRequested | 继续等待用户决策 |
| `reviewing` | `now > expiresAt` + `!shouldNotify` | 跳过通知 | 等待冷却期后重试 |
| `reviewing` | 用户确认解散 | lark-cli disband + delete state + remove label | 状态文件删除 |
| 非 `reviewing` | 任何 | 拒绝解散 | 无操作 |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `check-expired` 返回空数组 | 退出本次执行 |
| `send_interactive` 失败 | 记录错误，跳过此 PR |
| `mark-disband` 失败 | 记录错误，不阻塞后续 |
| `confirm-disband` 状态不是 reviewing | 拒绝解散，返回错误 |
| `lark-cli` 不可用 | 跳过群组解散，仍清理状态文件和 Label |
| `lark-cli` 解散失败 | 记录警告，继续删除状态文件 |
| `gh` Label 移除失败 | 记录警告，继续解散和删除 |
| 状态文件删除失败 | 记录警告 |
| 锁获取失败 | 跳过此 PR，下次重试 |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用（24h 冷却 + 锁内二次校验）
2. **24h 冷却**: 同一 PR 的解散通知每 24 小时最多发送一次
3. **状态保护**: 只有 `reviewing` 状态的 PR 可以被解散，`approved`/`closed` 状态会被拒绝
4. **并发安全**: 使用文件锁防止多个实例同时处理同一 PR
5. **优雅降级**: lark-cli 不可用时仍可清理状态文件和 Label
6. **串行处理**: 一次处理一个 PR，避免并发问题

## 验收标准

- [ ] 过期 PR 被正确识别（`now > expiresAt` 且 `state === reviewing`）
- [ ] 解散通知 24h 内不重复发送
- [ ] `state !== reviewing` 时拒绝解散
- [ ] 确认解散后正确清理（群组 + 状态文件 + Label）
- [ ] lark-cli 不可用时优雅降级
- [ ] 并发安全（文件锁保护）

## 关联

- Parent: #2210
- Depends on: #2219, #2220
- Issue: #2221
