---
name: "Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Discussion Lifecycle — 过期 PR 讨论群生命周期管理

定期扫描 `.temp-chats/` 状态文件，处理过期的 reviewing PR：发送解散申请卡片、执行解散确认、清理状态文件。

## 配置

- **状态文件目录**: `.temp-chats/`
- **执行间隔**: 每 10 分钟
- **解散申请冷却**: 24 小时（同一 PR 24h 内不重复发送解散申请）
- **Lifecycle 脚本**: `npx tsx schedules/discussion-lifecycle/lifecycle.ts`

## 职责边界

- ✅ 检测过期的 reviewing PR（`expiresAt < now`）
- ✅ 发送解散申请卡片（24h 冷却期）
- ✅ 确认解散后执行清理（群组 + 状态文件 + Label）
- ✅ 拒绝非 reviewing 状态的解散请求
- ❌ 不创建新讨论群（由 `pr-scanner` schedule 负责）
- ❌ 不发送 PR 通知卡片（由 `pr-scanner` schedule 负责）
- ❌ 不处理 PR 的 approve/close 动作（由 `pr-scanner` schedule 负责）

## 执行步骤

### Step 1: 检查过期的 reviewing PR

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action check-expired
```

输出 JSON 示例：
```json
{
  "expired": [
    {
      "prNumber": 123,
      "chatId": "oc_xxx",
      "state": "reviewing",
      "expiresAt": "2026-04-08T12:00:00Z",
      "canSendDisband": true,
      "lastDisbandRequested": null
    }
  ],
  "total": 1
}
```

如果 `total` 为 0，输出 "✅ 无过期 PR" 并**退出**。

### Step 2: 发送解散申请卡片

对每个 `canSendDisband: true` 的过期 PR，使用 `send_interactive` 发送解散确认卡片：

**参数**：
```json
{
  "chatId": "{chatId}",
  "title": "⏰ PR #{prNumber} 讨论已过期",
  "question": "PR #{prNumber} 的讨论群已超过有效期（过期于 {expiresAt}）。\n\n请确认是否解散此讨论群？",
  "options": [
    { "text": "✅ 确认解散", "value": "confirm_disband", "type": "primary" },
    { "text": "🔄 延长讨论", "value": "extend", "type": "default" }
  ],
  "actionPrompts": {
    "confirm_disband": "[用户操作] 用户确认解散 PR #{prNumber} 的讨论群。请执行以下步骤：\n1. 检查 PR 状态是否仍为 reviewing：`npx tsx schedules/discussion-lifecycle/lifecycle.ts --action check-expired`，确认 #{prNumber} 仍在列表中\n2. 如果 state ≠ reviewing，回复「⚠️ PR 状态已变更，拒绝解散」并**退出**\n3. 如果 state = reviewing，继续以下步骤：\n4. 执行 `lark-cli api DELETE /open-apis/im/v1/chats/{chatId}` 解散群组\n5. 执行 `npx tsx schedules/pr-scanner/scanner.ts --action remove-label --pr {prNumber} --repo hs3180/disclaude` 移除 GitHub label\n6. 执行 `npx tsx schedules/discussion-lifecycle/lifecycle.ts --action delete-state --pr {prNumber}` 删除状态文件\n7. 报告执行结果",
    "extend": "[用户操作] 用户选择延长 PR #{prNumber} 的讨论。请回复用户说明讨论已延长，下次过期时会再次提醒。"
  }
}
```

### Step 3: 更新 disbandRequested 时间戳

发送卡片后，更新状态文件以记录本次请求（24h 冷却期）：

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action mark-disband --pr {prNumber}
```

### Step 4: 跳过冷却期内的 PR

对 `canSendDisband: false` 的过期 PR（24h 内已发送过申请）：

- 记录 "⏸️ PR #{prNumber} 已发送解散申请，冷却中（上次：{lastDisbandRequested}）"
- **跳过**，不重复发送

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| lifecycle.ts 执行失败 | 记录错误，退出本次执行 |
| send_interactive 失败 | 记录错误，跳过该 PR，继续处理下一个 |
| 群组解散失败 | 记录错误，继续清理状态文件（群组可能已被手动解散） |
| Label 移除失败 | 忽略（非阻塞操作） |
| 状态文件删除失败 | 记录错误，继续处理下一个 PR |
| PR 状态已变更（≠ reviewing） | 拒绝解散，跳过该 PR |

## 状态转换

| 当前状态 | 条件 | 执行动作 | 结果 |
|----------|------|----------|------|
| reviewing + expired | canSendDisband=true | 发送解散卡片 + mark-disband | 等待用户确认 |
| reviewing + expired | canSendDisband=false | 跳过 | 冷却中 |
| reviewing + expired | 用户确认 + state=reviewing | 解散群组 + 删除状态 + 移除 label | 清理完成 |
| reviewing + expired | 用户确认 + state≠reviewing | 拒绝解散 | 跳过 |
| approved/closed | 不再是 reviewing | 不处理 | 由 pr-scanner 管理 |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用（24h 冷却期防止重复发送）
2. **无状态**: Schedule 不维护内存状态，所有状态从文件读取
3. **安全检查**: 解散前必须确认 state 仍为 reviewing，防止误操作
4. **串行处理**: 一次处理一个 PR，避免并发问题
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只处理 `.temp-chats/` 目录下的文件
7. **优雅降级**: 群组解散失败不影响状态文件清理

## 验收标准

- [ ] 过期 PR 被正确识别（state=reviewing 且 expiresAt < now）
- [ ] 解散申请卡片 24h 内不重复发送（canSendDisband 控制）
- [ ] state ≠ reviewing 时拒绝解散
- [ ] 确认解散后正确清理（群组 + 状态文件 + label）
- [ ] lifecycle.ts 的三个 action 均可正常执行

## 关联

- Parent: #2210
- Depends on: #2219 (scanner.ts), #2220 (SCHEDULE.md + 通知流程)
- Design: [pr-scanner-v2-design.md](../docs/designs/pr-scanner-design.md)
