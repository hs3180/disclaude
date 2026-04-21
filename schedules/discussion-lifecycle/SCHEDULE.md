---
name: "Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Discussion Lifecycle — 讨论群生命周期管理

管理 PR 讨论群的过期和解散流程。定期扫描 `.temp-chats/` 目录，对过期 PR 发送解散申请卡片，并在用户确认后执行清理。

> **Phase 2 of PR Scanner v2**: 依赖 scanner.ts (#2219) 和 SCHEDULE.md (#2220) 的基础功能。

## 配置

- **扫描间隔**: 每 10 分钟
- **解散去重窗口**: 24 小时（`disbandRequested` 后 24h 内不重复发送）
- **PR 过期时间**: 48 小时（由 scanner.ts create-state 设定）

## 前置依赖

- `lifecycle.ts`（本目录下的 CLI 脚本，Issue #2221）
- `scanner.ts`（PR 状态管理，Issue #2219）
- `lark-cli`（飞书群组解散）
- `send_interactive` MCP 工具（交互式卡片）

## 执行步骤

### Step 1: 检测过期 PR

```bash
npx tsx schedules/pr-scanner/lifecycle.ts --action check-expired
```

如果 `expired` 为空数组，**退出本次执行**（无过期 PR）。

### Step 2: 过滤需要通知的 PR

对返回的过期 PR 列表进行过滤：

- **跳过** `recentlyRequested: true` 的 PR（24h 内已发送过解散申请）
- **处理** `recentlyRequested: false` 的 PR（需要发送或重新发送解散申请）

如果所有过期 PR 都是 `recentlyRequested: true`，**退出本次执行**。

### Step 3: 发送解散申请卡片

对每个需要通知的 PR，使用 `send_interactive` 发送解散申请卡片：

```json
{
  "question": "## ⏰ 讨论群即将解散\n\n**PR #{prNumber}** 的讨论已超时（过期时间: {expiresAt}）。\n\n如果不再需要此讨论群，请确认解散。解散后将：\n- 解散飞书群组\n- 清理状态文件\n- 移除 `pr-scanner:reviewing` label\n\n如需保留，请点击「保留群组」。",
  "options": [
    { "text": "✅ 确认解散", "value": "confirm_disband", "type": "primary" },
    { "text": "🔒 保留群组", "value": "keep_group" }
  ],
  "title": "🔔 讨论群过期通知: PR #{prNumber}",
  "chatId": "{chatId}",
  "actionPrompts": {
    "confirm_disband": "[用户操作] 用户确认解散 PR #{prNumber} 的讨论群。请执行以下步骤：\n1. 检查 PR 状态是否仍为 reviewing：`npx tsx schedules/pr-scanner/lifecycle.ts --action disband --pr {prNumber} --skip-lark false`\n2. 如果成功，报告解散结果\n3. 如果状态不是 reviewing，告知用户当前状态并拒绝解散",
    "keep_group": "[用户操作] 用户选择保留 PR #{prNumber} 的讨论群。无需执行任何操作，群组将继续保留。"
  }
}
```

> **注意**: `{prNumber}`、`{chatId}`、`{expiresAt}` 需要替换为实际值。

### Step 4: 更新 disbandRequested 时间戳

发送卡片后，对每个 PR 更新时间戳（防止 24h 内重复发送）：

```bash
npx tsx schedules/pr-scanner/lifecycle.ts --action mark-disband --pr {prNumber}
```

### Step 5: 确认完成

输出本次扫描结果摘要：

```
📋 Discussion Lifecycle 扫描完成
- 过期 PR: {expiredCount} 个
- 发送解散通知: {notifiedCount} 个
- 跳过（近期已通知）: {skippedCount} 个
```

## 用户确认解散流程

当用户点击「确认解散」按钮时，由 actionPrompt 触发以下步骤：

### 1. 执行解散

```bash
npx tsx schedules/pr-scanner/lifecycle.ts --action disband --pr {prNumber}
```

该命令会依次执行：
1. **验证状态**: 检查 PR 状态是否为 `reviewing`，非 reviewing 则拒绝解散
2. **解散群组**: 通过 lark-cli 调用飞书 API 解散群组
3. **删除状态文件**: 删除 `.temp-chats/pr-{number}.json`
4. **移除 Label**: 移除 GitHub 上的 `pr-scanner:reviewing` label

### 2. 处理结果

- **成功**: 报告解散完成，列出各步骤结果
- **状态不匹配**: 告知用户当前状态（如已 approved/closed），不解散
- **群组解散失败**: 报告失败原因，但继续清理状态文件和 label（群组可能已被手动解散）

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| lifecycle.ts 执行失败 | 记录错误，退出本次执行 |
| `.temp-chats/` 目录不存在 | 正常退出（无 PR 需要管理） |
| 状态文件损坏 | 跳过该文件，记录警告 |
| `send_interactive` 失败 | 记录错误，不更新 disbandRequested（下次重试） |
| `mark-disband` 失败 | 记录错误，下次可能重复发送卡片 |
| `disband` 状态不匹配 | 拒绝解散，报告当前状态 |
| `disband` 群组解散失败 | 继续清理（状态文件 + label），记录警告 |
| `disband` label 移除失败 | 不阻塞，记录警告 |

## 状态转换

```
reviewing + expiresAt < now → 发送解散卡片 → 等待用户确认
  → 用户确认: disband (reviewing → 解散群组 + 删除文件 + 移除 label)
  → 用户保留: 无操作
```

## 不包含

- PR 发现和创建状态（由 pr-scanner SCHEDULE.md / Issue #2220 处理）
- PR 审核操作（approve/close，由 pr-scanner SCHEDULE.md 处理）
- 文件锁修复（已关闭的 Issue #2222）

## 关联

- Parent: #2210
- Depends on: #2219 (scanner.ts), #2220 (SCHEDULE.md + Label)
- This: #2221 (讨论群生命周期管理)
