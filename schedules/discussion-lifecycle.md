---
name: "Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Discussion Lifecycle — PR 讨论群过期检测与解散

每 10 分钟扫描 PR 讨论群状态，检测过期讨论并发送解散申请。

## 配置

- **状态文件目录**: `workspace/schedules/.temp-chats/`（PR 状态文件 `pr-{number}.json`）
- **扫描间隔**: 每 10 分钟
- **解散申请冷却**: 24 小时（`DISBAND_COOLDOWN_HOURS` 环境变量可覆盖）
- **仓库**: hs3180/disclaude

## 前置依赖

- `lark-cli`（飞书官方 CLI）
- `gh` CLI（GitHub 操作）
- `npx tsx`（运行 TypeScript 脚本）

## 职责边界

- ✅ 检测过期的 reviewing 状态 PR 讨论群
- ✅ 发送解散申请卡片（24 小时冷却）
- ✅ 验证 PR 状态后执行解散
- ✅ 解散后清理状态文件和 GitHub Label
- ❌ 不创建讨论群（由 pr-scanner schedule 负责）
- ❌ 不处理 approved/closed 状态的 PR（由 pr-scanner schedule 负责）

## 执行步骤

### Step 1: 检查过期讨论

```bash
npx tsx skills/pr-scanner/lifecycle.ts --action check-expired
```

解析输出 JSON，获取 `expired` 数组。

如果 `expired` 为空数组，**退出本次执行**。

### Step 2: 筛选可发送解散申请的讨论

从 `expired` 数组中筛选 `disbandEligible === true` 的条目。

对每个 eligible PR：

### Step 3: 发送解散申请卡片

使用 `send_interactive` 或 `send_card` 向讨论群发送解散确认卡片：

**卡片内容**：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "⏰ PR 讨论群已过期", "tag": "plain_text"}, "template": "orange"},
  "elements": [
    {"tag": "markdown", "content": "PR #{prNumber} 的讨论已超过有效期。\n\n- 过期时间: {expiresAt}\n- 讨论群: {chatId}\n\n请确认是否解散此讨论群？"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ 确认解散", "tag": "plain_text"}, "value": "confirm_disband_{prNumber}", "type": "primary"},
      {"tag": "button", "text": {"content": "⏳ 延长 24h", "tag": "plain_text"}, "value": "extend_{prNumber}"}
    ]},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "此消息每 24 小时重复发送一次，直到确认解散或延长"}
    ]}
  ]
}
```

**actionPrompts**：
```json
{
  "confirm_disband_{prNumber}": "[用户操作] 用户确认解散 PR #{prNumber} 的讨论群。请执行以下步骤：\n1. 运行 `npx tsx skills/pr-scanner/lifecycle.ts --action confirm-disband --pr {prNumber}` 验证状态\n2. 如果 success=true，执行解散流程\n3. 如果 success=false（state≠reviewing），告知用户原因并停止",
  "extend_{prNumber}": "[用户操作] 用户选择延长 PR #{prNumber} 的讨论时间。请手动更新状态文件的 expiresAt 字段延长 24 小时。"
}
```

> ⚠️ **注意**: 如果 `chatId` 为 null，说明群聊未创建，跳过发送卡片，直接进入 Step 5 清理。

### Step 4: 更新 disbandRequested 时间戳

对每个已发送卡片的 PR：

```bash
npx tsx skills/pr-scanner/lifecycle.ts --action mark-disband --pr {prNumber}
```

这会更新 `disbandRequested` 时间戳，确保 24 小时内不重复发送。

### Step 5: 处理确认解散

当用户点击「确认解散」按钮时，执行以下流程：

#### 5a: 验证 PR 状态

```bash
npx tsx skills/pr-scanner/lifecycle.ts --action confirm-disband --pr {prNumber}
```

检查返回的 `success` 字段：
- `true` → 继续解散流程
- `false`（state ≠ reviewing）→ 告知用户「该 PR 已处于 `{state}` 状态，无需解散」并停止

#### 5b: 解散群组

```bash
lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
```

> 如果解散失败（群组已不存在等），记录警告但继续后续清理步骤。

#### 5c: 移除 GitHub Label

```bash
gh pr edit {prNumber} --repo hs3180/disclaude --remove-label "pr-scanner:reviewing"
```

> Label 移除失败不影响流程（可能已被手动移除）。

#### 5d: 清理状态文件

```bash
npx tsx skills/pr-scanner/lifecycle.ts --action cleanup-state --pr {prNumber}
```

## 状态转换

| 当前状态 | 条件 | 执行动作 | 新状态 |
|----------|------|----------|--------|
| `reviewing` | `expiresAt` 已过期 且 从未请求解散 | 发送解散卡片 + mark-disband | `reviewing`（disbandRequested 更新） |
| `reviewing` | `expiresAt` 已过期 且 距上次请求 ≥ 24h | 再次发送解散卡片 + mark-disband | `reviewing`（disbandRequested 更新） |
| `reviewing` | `expiresAt` 已过期 且 距上次请求 < 24h | 跳过（冷却中） | 不变 |
| `reviewing` | 用户确认解散 | confirm-disband + dissolve + cleanup | 状态文件删除 |
| `≠ reviewing` | 用户确认解散 | 拒绝解散 | 不变 |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 状态目录不存在 | 正常退出（无过期讨论） |
| 状态文件损坏 | 记录警告，跳过该文件 |
| 群组解散失败 | 记录警告，继续清理状态文件和 label |
| Label 移除失败 | 记录警告，不影响流程 |
| 状态文件已不存在 | 标记为已清理，跳过 |
| `lark-cli` 不可用 | 跳过群操作，仅更新状态文件 |

## 注意事项

1. **幂等性**: `mark-disband` 和 `cleanup-state` 操作是幂等的
2. **冷却机制**: 解散申请卡片 24 小时内不重复发送，避免骚扰用户
3. **无状态设计**: Schedule 不维护内存状态，所有状态从文件读取
4. **串行处理**: 一次处理一个 PR，避免并发问题
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **默认禁用**: 需要依赖 pr-scanner Phase A/B 合并后才能启用

## 验收标准

- [ ] 过期 PR（state=reviewing, expiresAt < now）被正确识别
- [ ] 解散申请卡片 24 小时内不重复发送（disbandEligible 判断正确）
- [ ] state ≠ reviewing 时拒绝解散
- [ ] 确认解散后正确执行：群组解散 + 状态文件删除 + Label 移除
- [ ] 所有 CLI action 输出有效 JSON
- [ ] 文件操作有锁保护，防止并发冲突

## 关联

- Parent: #2210 (PR Scanner v2)
- Depends on: #2219 (Phase A), #2220 (Phase B)
- This issue: #2221 (Phase C)
