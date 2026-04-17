---
name: "Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-18T00:00:00.000Z
---

# Discussion Lifecycle — 讨论群过期与解散管理

自动检测过期的 PR 审查讨论群，发送解散申请卡片，并在用户确认后执行解散和清理。

## 配置

- **状态目录**: `.temp-chats/`
- **扫描间隔**: 每 10 分钟
- **解散通知冷却**: 24 小时（`DISBAND_COOLDOWN_HOURS` 环境变量可覆盖）
- **仓库**: hs3180/disclaude

## 前置依赖

- `lifecycle.ts`（讨论群生命周期管理脚本，Issue #2221）
- `scanner.ts`（PR Scanner CLI 脚本，Issue #2219 提供）
- `gh` CLI（GitHub CLI，用于 Label 管理）
- `lark-cli`（飞书 CLI，用于解散群组）
- MCP Tool: `send_interactive`（用于发送可点击的交互式卡片）

## 职责边界

- ✅ 检测过期的 PR 审查（`expiresAt < now`）
- ✅ 发送解散申请卡片（24h 冷却）
- ✅ 处理用户确认后的解散流程
- ✅ 解散群组（lark-cli）
- ✅ 删除状态文件
- ✅ 移除 GitHub Label
- ❌ 不创建新讨论群（由 PR Scanner v2 SCHEDULE 负责）
- ❌ 不处理未过期的 PR
- ❌ 不修改 scanner.ts 的核心逻辑

## 执行步骤

### Step 1: 扫描过期 PR

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action check-expired
```

解析 JSON 输出：
- `{"expired": [...], "total": N}` — 继续处理
- `{"expired": [], "total": 0}` — **退出本次执行**，无过期 PR

### Step 2: 发送解散申请通知

对每个过期 PR（按 `needsNotification` 筛选）：

如果 `needsNotification === false`（24h 内已发送过通知），**跳过**。

如果 `needsNotification === true`，发送解散申请卡片：

#### 2a. 检查 PR 状态（安全检查）

在发送解散通知前，先检查 state 字段：
- **`state !== 'reviewing'`** → **跳过此 PR**（已 approved 或 closed，不需要解散）
- **`state === 'reviewing'`** → 继续发送通知

#### 2b. 发送交互式卡片

使用 `send_interactive` 工具：

**调用参数**:
```
tool: send_interactive
title: "⏰ PR #{prNumber} 审查已过期"
question: |
  PR #{prNumber} 的审查已超时（过期时间: {expiresAt}）。

  请选择处理方式：

options:
  - text: "✅ 确认解散", value: "confirm_disband", type: "primary"
  - text: "⏳ 延长审查", value: "extend_review", type: "default"
chatId: {当前 schedule chatId（如果 chatId 为 null）或 PR 的 chatId}
actionPrompts:
  confirm_disband: "[用户操作] 用户确认解散 PR #{prNumber} 的讨论群。请执行以下步骤：1. 运行 `npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {prNumber} --state closed` 更新状态 2. 运行 `gh pr edit {prNumber} --repo hs3180/disclaude --remove-label 'pr-scanner:reviewing'` 移除 label 3. 如果 chatId 不为 null，运行 `lark-cli api DELETE /open-apis/im/v1/chats/{chatId}` 解散群组 4. 运行 `rm .temp-chats/pr-{prNumber}.json` 删除状态文件 5. 报告执行结果"
  extend_review: "[用户操作] 用户延长 PR #{prNumber} 的审查。请执行以下步骤：1. 运行 `npx tsx schedules/pr-scanner/scanner.ts --action create-state --pr {prNumber}` 重新创建状态文件（重置 expiresAt 为 48h 后）2. 报告执行结果"
```

> **⚠️ 关键**: 必须包含 `actionPrompts`，否则按钮仅为展示用途，无法点击。

#### 2c. 更新 disbandRequested 时间戳

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts --action mark-disband --pr {prNumber}
```

这确保 24h 内不会重复发送解散通知。

### Step 3: 处理用户确认（由 actionPrompt 触发）

用户点击「确认解散」后，由 actionPrompt 触发新的 agent 响应，执行以下操作：

1. **验证 state** — 重新检查状态文件，确认 `state === 'reviewing'`
   - 如果 `state !== 'reviewing'`（已被其他流程处理），**拒绝解散**并报告原因

2. **更新 scanner 状态** — 标记为 closed：
   ```bash
   npx tsx schedules/pr-scanner/scanner.ts --action mark --pr {prNumber} --state closed
   ```

3. **移除 GitHub Label**：
   ```bash
   gh pr edit {prNumber} --repo hs3180/disclaude --remove-label "pr-scanner:reviewing"
   ```
   > Label 移除失败**不阻塞**解散流程。

4. **解散群组**（仅当 chatId 不为 null）：
   ```bash
   lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
   ```
   > 解散失败**不阻塞**后续清理（群组可能已被手动解散）。

5. **删除状态文件**：
   ```bash
   rm .temp-chats/pr-{prNumber}.json
   ```

6. **报告结果** — 告知用户解散操作的结果

## 状态管理

### 过期判断逻辑

```
now > expiresAt  →  PR 审查已过期
```

### 解散通知冷却

```
disbandRequested === null          →  从未发送过通知 → 需要发送
disbandRequested >= 24h ago        →  冷却已过 → 需要发送
disbandRequested < 24h ago         →  冷却中 → 跳过
```

### 安全检查

```
state === 'reviewing'              →  可以发送解散通知 / 执行解散
state !== 'reviewing'              →  已处理（approved/closed），跳过
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| lifecycle.ts 执行失败 | 记录错误，退出本次执行，等待下次调度 |
| `send_interactive` 发送失败 | 记录错误，不更新 disbandRequested，下次调度重试 |
| `lark-cli` 解散群组失败 | 记录警告，继续后续清理（群组可能已被手动解散） |
| `gh pr edit` (Label) 失败 | **忽略**，不阻塞主流程。Label 仅为兜底可见性 |
| scanner.ts `mark` 失败 | 记录错误，报告给用户，不继续解散 |
| 状态文件已被删除 | 跳过该 PR，下次调度不会再出现 |
| PR state 已不是 reviewing | 跳过，不发送通知 / 不执行解散 |
| chatId 为 null (Phase 1) | 使用 admin chatId 发送通知，不尝试解散群组 |

## 注意事项

1. **幂等性**: `check-expired` 是只读操作，重复执行无副作用。`mark-disband` 仅更新时间戳，重复执行更新为最新时间。
2. **串行处理**: 一次处理一个过期 PR（避免 API 限流），但每次调度可扫描多个。
3. **24h 冷却**: 解散通知 24h 内不重复发送，通过 `disbandRequested` 字段控制。
4. **状态安全**: 解散前必须验证 `state === 'reviewing'`，避免误解散已处理的 PR。
5. **不创建新 Schedule**: 这是定时任务执行环境的规则。
6. **不修改其他文件**: 只通过 lifecycle.ts 和 scanner.ts 管理 `.temp-chats/` 目录。
7. **send_interactive 必须**: 使用 `send_interactive`（非 `send_card`）发送交互式卡片，确保按钮可点击。
8. **actionPrompts 必须**: 必须包含 `actionPrompts`，否则按钮不可点击。
9. **Phase 1 兼容**: chatId 为 null 时（Phase 1 未创建讨论群），使用 admin chatId 发送通知，不尝试解散群组。

## 验收标准

- [ ] 过期 PR 被正确识别（`expiresAt < now`）
- [ ] 解散申请卡片 24h 内不重复发送
- [ ] state ≠ reviewing 时跳过（不发送通知、不执行解散）
- [ ] 确认解散后正确执行：scanner state → closed + label 移除 + 群组解散 + 状态文件删除
- [ ] 群组解散失败不影响后续清理
- [ ] Label 移除失败不阻塞主流程
- [ ] lifecycle.ts JSON 输出可被 AI Agent 正确解析
- [ ] `send_interactive` 卡片按钮可点击并触发正确 actionPrompt
