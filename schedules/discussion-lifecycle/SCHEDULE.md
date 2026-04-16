---
name: "Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Discussion Lifecycle — PR 讨论群过期与解散管理

定期扫描 `.temp-chats/` 中的 PR 状态文件，对过期讨论群发送解散申请卡片，
并在人类确认后执行解散操作。

## 配置

- **状态文件目录**: `.temp-chats/`
- **执行间隔**: 每 10 分钟
- **解散申请冷却**: 24 小时（同一 PR 不重复发送解散申请）
- **仓库**: hs3180/disclaude

## 前置依赖

- `lark-cli`（飞书官方 CLI，npm 全局安装）
- `npx tsx`（运行 TypeScript 脚本）

## 职责边界

- ✅ 扫描过期 PR 状态文件
- ✅ 发送解散申请卡片到讨论群
- ✅ 更新 `disbandRequested` 时间戳
- ✅ 执行确认后的解散操作（群 + 状态文件 + Label）
- ❌ 不创建新讨论群（由 `pr-scanner` schedule 负责）
- ❌ 不修改 PR 状态（`reviewing/approved/closed`，由 `scanner.ts` 管理）

## 执行步骤

```bash
npx tsx schedules/pr-scanner/lifecycle.ts --action check-expired
```

### Step 1: 获取过期 PR 列表

运行 `check-expired` 获取所有过期 PR：

```bash
npx tsx schedules/pr-scanner/lifecycle.ts --action check-expired
```

输出为 JSON 数组，每个元素包含：

| 字段 | 类型 | 说明 |
|------|------|------|
| `prNumber` | number | PR 编号 |
| `chatId` | string | 讨论群 chatId |
| `state` | string | 当前状态（reviewing/approved/closed） |
| `expiresAt` | string | 过期时间 |
| `disbandRequested` | string\|null | 上次解散申请时间 |
| `canSendDisbandRequest` | boolean | 是否可以发送新的解散申请（24h 冷却） |

### Step 2: 筛选可操作的 PR

仅对满足以下条件的 PR 发送解散申请：

1. `canSendDisbandRequest === true`（无申请记录或距上次 >= 24h）
2. `state === 'reviewing'`（仅 reviewing 状态可申请解散）

> **注意**: `state !== 'reviewing'` 的 PR（如 `approved` 或 `closed`）说明已有人处理，
> 不需要发送解散申请，直接跳过。

### Step 3: 发送解散申请卡片

对每个符合条件的 PR，向其讨论群发送交互式卡片：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "⏰ 讨论群即将解散", "tag": "plain_text"}, "template": "orange"},
  "elements": [
    {"tag": "markdown", "content": "PR #{number} 的讨论已超过 48 小时。\n\n**当前状态**: reviewing\n**过期时间**: {expiresAt}\n\n请确认是否解散此讨论群。解散后状态文件将被清除，`pr-scanner:reviewing` Label 将被移除。"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ 确认解散", "tag": "plain_text"}, "value": "confirm-disband-{number}", "type": "danger"},
      {"tag": "button", "text": {"content": "❌ 继续讨论", "tag": "plain_text"}, "value": "keep-alive-{number}"}
    ]}
  ]
}
```

**actionPrompts**：
```json
{
  "confirm-disband-{number}": "[用户操作] 用户确认解散 PR #{number} 的讨论群。请执行以下步骤：\n1. 检查 PR #{number} 的当前状态：`gh pr view {number} --repo hs3180/disclaude --json state,labels`\n2. 如果 PR 状态不是 open，跳过解散（PR 已关闭/合并）\n3. 如果 PR 有 `pr-scanner:reviewing` label，移除它：`gh pr edit {number} --repo hs3180/disclaude --remove-label 'pr-scanner:reviewing'`\n4. 删除状态文件：`rm .temp-chats/pr-{number}.json`\n5. 通过 lark-cli 解散讨论群：`lark-cli api DELETE /open-apis/im/v1/chats/{chatId}`\n6. 报告执行结果",
  "keep-alive-{number}": "[用户操作] 用户选择保留 PR #{number} 的讨论群。请执行以下步骤：\n1. 更新状态文件的过期时间（延长 48 小时）：运行 `npx tsx schedules/pr-scanner/lifecycle.ts --action mark-disband --pr {number}`（注意：这里实际需要更新 expiresAt，目前 mark-disband 只更新 disbandRequested。如需延长，请手动编辑 .temp-chats/pr-{number}.json 中的 expiresAt 字段）\n2. 通知用户讨论群已保留"
}
```

### Step 4: 记录解散申请时间

发送卡片后，立即记录解散申请时间：

```bash
npx tsx schedules/pr-scanner/lifecycle.ts --action mark-disband --pr {number}
```

这会更新状态文件中的 `disbandRequested` 字段，防止 24 小时内重复发送。

### Step 5: 输出摘要

执行完成后输出摘要：

```
扫描完成：发现 {total} 个过期 PR，发送 {sent} 个解散申请，跳过 {skipped} 个
```

## 状态转换

| 场景 | 条件 | 执行动作 |
|------|------|----------|
| 正常过期 | `expiresAt < now` 且 `canSendDisbandRequest` | 发送解散申请卡片 |
| 冷却期内 | `disbandRequested` 距今 < 24h | 跳过（不重复发送） |
| 非 reviewing | `state !== 'reviewing'` | 跳过（已有人处理） |
| 确认解散 | 用户点击"确认解散" | 删除状态文件 + 移除 Label + 解散群 |
| 继续讨论 | 用户点击"继续讨论" | 延长过期时间 |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `.temp-chats/` 目录不存在 | 正常退出（无状态文件 = 无需处理） |
| 状态文件损坏（非 JSON） | 记录警告，跳过该文件 |
| 发送卡片失败 | 记录错误，跳过该 PR（不影响其他 PR） |
| mark-disband 失败 | 记录错误，不发送卡片（防止重复发送） |
| 解散群失败 | 记录错误，仍删除状态文件（群可能已被手动解散） |
| Label 移除失败 | 记录错误，不阻塞流程 |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用（24h 冷却 + disbandRequested 时间戳）
2. **有限处理**: 每次执行处理所有过期 PR（讨论群数量有限，不会 API 限流）
3. **无状态**: Schedule 不维护内存状态，所有状态从文件读取
4. **人类确认**: 解散操作需要人类确认，不会自动执行
5. **优雅降级**: 发送卡片失败不影响其他 PR 的处理
6. **安全防护**: 仅处理 `state === 'reviewing'` 的 PR，避免误操作已处理的 PR
7. **不创建新 Schedule**: 这是定时任务执行环境的规则

## 关联

- Parent Issue: #2210
- Depends on: #2219 (scanner.ts), #2220 (SCHEDULE.md + label-manager)
- Design: pr-scanner-v2-design.md §3.3
- Coordinate with: #1547 (chat-timeout schedule — 处理 `workspace/chats/` 目录)
