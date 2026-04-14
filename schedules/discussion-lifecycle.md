---
name: "Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-15T00:00:00.000Z
---

# Discussion Lifecycle — PR Scanner v2 Phase 2

管理过期 PR 讨论群的生命周期：检测过期条目，发送解散申请卡片，执行解散清理。

## 配置

- **仓库**: hs3180/disclaude
- **状态目录**: `.temp-chats/`（scanner.ts 管理）
- **扫描间隔**: 每 10 分钟
- **解散冷却**: 24 小时（避免重复发送解散申请）
- **过期时间**: 48 小时（scanner.ts 创建时设定）
- **GitHub Label**: `pr-scanner:reviewing`

## 前置依赖

- `gh` CLI（GitHub Label 操作）
- `npx tsx`（运行 lifecycle.ts）
- `skills/pr-scanner/lifecycle.ts`（本 Issue 提供的生命周期 CLI）
- `skills/pr-scanner/scanner.ts`（#2219 提供的状态管理 CLI）

## 执行步骤

### Step 1: 检测过期 PR

```bash
npx tsx skills/pr-scanner/lifecycle.ts --action check-expired
```

解析 JSON 输出数组，每个元素格式：
```json
{
  "prNumber": 123,
  "chatId": "oc_xxx",
  "needsDisbandRequest": true
}
```

如果返回空数组 `[]`，**退出本次执行**（无过期 PR）。

### Step 2: 处理每个过期 PR

遍历 Step 1 返回的数组，对每个过期 PR 执行以下操作：

#### 2a. 检查 state 是否仍为 reviewing

读取 `.temp-chats/pr-{prNumber}.json`，确认 `state === "reviewing"`。

如果 `state !== "reviewing"`（例如已变为 `approved` 或 `closed`），**跳过此 PR**（不需要解散讨论群）。

#### 2b. 发送解散申请卡片（仅 needsDisbandRequest === true）

使用 `send_interactive` 发送解散确认卡片：

**chatId**: 过期 PR 的 `chatId`

**format**: `"card"`

**content**（卡片 JSON）:
```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"content": "⏰ PR #{prNumber} 讨论已过期", "tag": "plain_text"},
    "template": "orange"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "PR #{prNumber} 的讨论已超过 48 小时未处理。\n\n请确认是否解散此讨论群："
    },
    {"tag": "hr"},
    {
      "tag": "action",
      "actions": [
        {"tag": "button", "text": {"content": "✅ 确认解散", "tag": "plain_text"}, "value": "confirm_disband", "type": "primary"},
        {"tag": "button", "text": {"content": "🔄 继续保留", "tag": "plain_text"}, "value": "keep", "type": "default"}
      ]
    }
  ]
}
```

**actionPrompts**:
```json
{
  "confirm_disband": "[用户操作] 用户确认解散 PR #{prNumber} 的讨论群。请执行以下步骤：\n1. 确认 state 仍为 reviewing（否则拒绝解散）\n2. 如果使用 lark-cli: `lark-cli group disband {chatId}`\n3. `npx tsx skills/pr-scanner/lifecycle.ts --action cleanup --pr {prNumber} --repo hs3180/disclaude`\n4. 报告结果",
  "keep": "[用户操作] 用户选择保留 PR #{prNumber} 的讨论群。请执行：`npx tsx skills/pr-scanner/scanner.ts --action mark --pr {prNumber} --state reviewing --repo hs3180/disclaude`（重置 updatedAt，延长讨论时间）"
}
```

#### 2c. 更新 disbandRequested 时间戳

发送卡片后（无论是否 needsDisbandRequest），更新时间戳以记录本次检查：

```bash
npx tsx skills/pr-scanner/lifecycle.ts --action mark-disband --pr {prNumber}
```

这会将 `disbandRequested` 设为当前时间，用于 24 小时冷却计算。

> **注意**: 仅在 `needsDisbandRequest === true` 时才发送卡片 + mark-disband。
> 如果 `needsDisbandRequest === false`（冷却期内），跳过此 PR，不做任何操作。

### Step 3: 确认解散后的清理

用户点击"确认解散"按钮后，执行清理流程：

1. **验证 state**: 读取 state file，确认 `state === "reviewing"`
   - 如果 `state !== "reviewing"` → 拒绝解散，告知用户 PR 已被处理

2. **解散群聊**（如果使用 lark-cli）:
   ```bash
   lark-cli group disband {chatId}
   ```
   > 如果 lark-cli 不可用，跳过此步骤（仅清理状态文件和 label）

3. **清理状态文件 + 移除 label**:
   ```bash
   npx tsx skills/pr-scanner/lifecycle.ts --action cleanup --pr {prNumber} --repo hs3180/disclaude
   ```
   这会：
   - 删除 `.temp-chats/pr-{prNumber}.json`
   - 移除 GitHub `pr-scanner:reviewing` label

## 状态管理

### disbandRequested 字段

| 值 | 含义 |
|------|------|
| `null` | 未发送过解散申请 |
| ISO 时间戳 | 上次发送解散申请的时间 |

### 冷却机制

- `check-expired` 检测 `now - disbandRequested >= 24h` 时才标记 `needsDisbandRequest: true`
- 避免每 10 分钟重复发送解散卡片

### 状态转换

```
reviewing + 未过期 → 无操作
reviewing + 过期 + disbandRequested=null → 发送解散卡片 + mark-disband
reviewing + 过期 + disbandRequested < 24h → 跳过（冷却中）
reviewing + 过期 + disbandRequested >= 24h → 重新发送解散卡片 + mark-disband
reviewing + 用户确认解散 → cleanup（删除文件 + 移除 label + 解散群聊）
approved/closed + 过期 → 跳过（已处理）
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| lifecycle.ts 失败 | 记录错误，跳过当前 PR |
| lark-cli 不可用 | 跳过群聊解散，仅清理状态文件和 label |
| Label 移除失败 | lifecycle.ts 内部记录 WARN，不阻塞主流程 |
| state file 已被删除 | cleanup 报告 WARN，继续清理 label |
| state 不是 reviewing | 拒绝解散操作，告知用户 |

## 注意事项

1. **幂等性**: mark-disband 可以安全重复调用（只更新时间戳）
2. **24h 冷却**: 防止解散卡片刷屏，每 24h 最多发送一次
3. **State 校验**: 解散前必须检查 state 仍为 reviewing
4. **Label 清理**: cleanup 会在删除文件的同时移除 GitHub label
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改 scanner.ts**: lifecycle.ts 是独立脚本，复用 schema.ts

## 验收标准

- [ ] 过期 PR 被正确识别（now > expiresAt 且 state === reviewing）
- [ ] 解散申请卡片 24h 内不重复发送
- [ ] state ≠ reviewing 时拒绝解散
- [ ] 确认解散后正确清理（群 + 状态文件 + label）
- [ ] lifecycle.ts 输出 JSON 可被 AI Agent 解析
- [ ] 错误路径有回退方案

## 关联

- Parent: #2210
- Depends on: #2219 (scanner.ts — PR #2324), #2220 (SCHEDULE.md — PR #2334)
- Issue: #2221
- Design: pr-scanner-v2-design.md §3.3
