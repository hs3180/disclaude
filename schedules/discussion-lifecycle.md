---
name: "Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Discussion Lifecycle — PR 讨论群过期管理

自动扫描过期的 PR 讨论群，发送解散申请卡片，处理确认解散流程。

## 配置

- **状态目录**: `.temp-chats/`
- **执行间隔**: 每 10 分钟
- **解散冷却期**: 24 小时（同一 PR 的解散通知 24h 内不重复发送）
- **仓库**: hs3180/disclaude

## 前置依赖

- ✅ Sub-Issue A (#2219) scanner.ts 基础脚本
- ✅ Sub-Issue B (#2220) SCHEDULE.md + 通知流程

## 职责边界

- ✅ 检测过期的 reviewing PR
- ✅ 发送解散申请卡片（send_interactive）
- ✅ 处理用户确认解散
- ✅ 解散后清理（群组 + 状态文件 + label）
- ❌ 不处理非 reviewing 状态的 PR
- ❌ 不创建新讨论群
- ❌ 不扫描新 PR

## 执行步骤

### 1. 检查过期 PR

```bash
npx tsx schedules/pr-scanner/lifecycle.ts --action check-expired
```

输出包含 `items` 数组，每项包含：
- `prNumber`: PR 编号
- `chatId`: 讨论群 chatId（可能为 null）
- `state`: 当前状态（应为 reviewing）
- `expiresAt`: 过期时间
- `disbandRequested`: 上次解散请求时间（null = 从未请求）
- `withinCooldown`: 是否在 24h 冷却期内

如果 `eligible === 0`，**退出本次执行**。

### 2. 过滤可通知的 PR

从 `items` 中筛选 `withinCooldown === false` 的 PR（即上次解散请求已超过 24h 或从未请求）。

如果所有 PR 都在冷却期内，**退出本次执行**。

### 3. 发送解散申请卡片

对每个可通知的 PR：

#### 3a. 状态二次检查

读取 `.temp-chats/pr-{number}.json`，确认 `state` 仍为 `reviewing`。
如果 `state !== reviewing`，跳过此 PR（可能已被其他流程更新）。

#### 3b. 发送卡片

使用 `send_interactive` 向讨论群发送解散申请卡片：

**卡片内容**（format: "card"）：
```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "⏰ 讨论群已过期", "tag": "plain_text"}, "template": "orange"},
    "elements": [
      {"tag": "markdown", "content": "PR #{number} 的讨论群已超过有效期（过期时间: {expiresAt}）。"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "✅ 确认解散", "tag": "plain_text"}, "value": "confirm_disband_{number}", "type": "primary"},
        {"tag": "button", "text": {"content": "🔄 续期 24h", "tag": "plain_text"}, "value": "extend_{number}"}
      ]},
      {"tag": "note", "elements": [
        {"tag": "plain_text", "content": "如无操作，将在下次扫描时再次提醒"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "{chatId}",
  "actionPrompts": {
    "confirm_disband_{number}": "[用户操作] 用户确认解散 PR #{number} 的讨论群。请执行以下步骤：\n1. 验证 state 仍为 reviewing\n2. 使用 lark-cli 解散群组\n3. 删除 .temp-chats/pr-{number}.json\n4. 移除 GitHub pr-scanner:reviewing label",
    "extend_{number}": "[用户操作] 用户续期 PR #{number} 讨论群 24h。请执行以下步骤：\n1. 读取 .temp-chats/pr-{number}.json\n2. 将 expiresAt 更新为当前时间 + 24h\n3. 将 disbandRequested 设为 null\n4. 写回文件"
  }
}
```

**注意**：如果 `chatId` 为 null，跳过此 PR 的卡片发送（群组可能尚未创建）。

#### 3c. 更新 disbandRequested

```bash
npx tsx schedules/pr-scanner/lifecycle.ts --action mark-disband --pr {number}
```

记录解散请求时间，确保 24h 冷却期。

### 4. 处理用户确认解散

当用户点击"✅ 确认解散"按钮时，由 actionPrompt 触发以下流程：

#### 4a. 二次状态检查

```bash
cat .temp-chats/pr-{number}.json
```

检查 `state` 字段：
- 如果 `state !== reviewing` → **拒绝解散**，告知用户 PR 状态已变更
- 如果 `state === reviewing` → 继续

#### 4b. 解散群组

```bash
lark-cli im --chat-id {chatId} --action disband
```

**错误处理**：如果 lark-cli 失败，记录错误但继续清理（群组可能已被手动解散）。

#### 4c. 删除状态文件

```bash
rm .temp-chats/pr-{number}.json
```

#### 4d. 移除 GitHub label

```bash
gh pr edit {number} --repo hs3180/disclaude --remove-label "pr-scanner:reviewing"
```

**错误处理**：如果 label 移除失败，记录错误但不阻塞流程。

## 状态转换

| 当前状态 | 条件 | 执行动作 | 新状态 |
|----------|------|----------|--------|
| `reviewing` | 已过期 + 无 chatId | 跳过 | `reviewing` (不变) |
| `reviewing` | 已过期 + 冷却期内 | 跳过通知 | `reviewing` (不变) |
| `reviewing` | 已过期 + 可通知 | 发送卡片 + mark-disband | `reviewing` (disbandRequested 已更新) |
| `reviewing` | 用户确认解散 | 解散群 + 删文件 + 移 label | (文件已删除) |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `.temp-chats/` 不存在 | 正常退出（无 PR 需要管理） |
| chatId 为 null | 跳过卡片发送，等待 pr-scanner 更新 |
| send_interactive 失败 | 记录错误，不更新 disbandRequested（下次重试） |
| lark-cli 解散失败 | 记录错误，继续清理文件和 label |
| label 移除失败 | 记录错误，不阻塞 |
| 状态文件损坏 | 跳过（check-expired 已处理） |

## 注意事项

1. **幂等性**: 重复执行不会重复发送通知（24h 冷却期保护）
2. **状态安全**: 解散前必须验证 state === reviewing
3. **优雅降级**: 群组解散失败不影响文件清理
4. **串行处理**: 一次处理一个 PR，避免并发问题
5. **不创建新 Schedule**: 定时任务执行环境的规则

## 验收标准

- [ ] 过期 PR 被正确识别
- [ ] 解散申请卡片 24h 内不重复发送
- [ ] state ≠ reviewing 时拒绝解散
- [ ] 确认解散后正确清理（群 + 状态文件 + label）

## 关联

- Parent: #2210
- Depends on: #2219, #2220
- Design: pr-scanner-v2-design.md §3.3
