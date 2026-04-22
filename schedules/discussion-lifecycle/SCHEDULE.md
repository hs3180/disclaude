---
name: "Discussion Lifecycle"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Discussion Lifecycle — PR 讨论群过期管理

自动管理 PR Scanner 创建的讨论群生命周期：检测过期 PR、发送解散申请卡片、处理确认解散。

## 配置

- **状态目录**: `.temp-chats/`
- **执行间隔**: 每 10 分钟
- **解散申请间隔**: ≥ 24 小时（不重复发送）
- **仓库**: hs3180/disclaude

## 前置依赖

- `@larksuite/cli`（飞书官方 CLI，用于解散群组）
- `gh` CLI（用于移除 GitHub Label）

## 执行步骤

### Step 1: 检测过期 PR

```bash
SKIP_LARK_CHECK=1 npx tsx schedules/discussion-lifecycle/lifecycle.ts check-expired
```

输出为 JSON 数组，包含所有 `now > expiresAt` 的 PR 状态文件。

如果返回空数组 `[]`，退出本次执行。

### Step 2: 筛选需要发送解散申请的 PR

对每个过期 PR，检查 `disbandRequested` 字段：

- 如果 `disbandRequested` 为 `null` → **需要发送解散申请**
- 如果 `disbandRequested` 距今 < 24 小时 → **跳过**（24h 内不重复发送）
- 如果 `disbandRequested` 距今 ≥ 24 小时 → **需要重新发送解散申请**

同时检查 `state` 字段：
- 如果 `state` ≠ `reviewing` → **跳过**（已处理过的 PR 无需解散）

### Step 3: 发送解散申请卡片

对每个需要发送解散申请的 PR，使用 `send_interactive` 发送交互式卡片：

**卡片内容**（format: "card"）：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "⚠️ 讨论群即将解散", "tag": "plain_text"}, "template": "orange"},
  "elements": [
    {"tag": "markdown", "content": "PR #{prNumber} 的讨论群已超过有效期（过期时间: {expiresAt}）。\n\n请确认是否解散此讨论群。"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "✅ 确认解散", "tag": "plain_text"}, "value": "confirm_disband", "type": "primary"},
      {"tag": "button", "text": {"content": "⏳ 延长 24h", "tag": "plain_text"}, "value": "extend_24h"}
    ]},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "未操作将保持当前状态，下次扫描时会再次提醒"}
    ]}
  ]
}
```

**actionPrompts**：
```json
{
  "confirm_disband": "[用户操作] 用户确认解散 PR #{prNumber} 的讨论群。请执行解散流程：\n1. 确认 PR state 为 reviewing（state ≠ reviewing 时拒绝解散）\n2. 执行 `npx tsx schedules/discussion-lifecycle/lifecycle.ts disband {prNumber}`\n3. 报告执行结果",
  "extend_24h": "[用户操作] 用户延长 PR #{prNumber} 讨论群 24 小时。请执行：\n1. 将 expiresAt 延长 24 小时（更新状态文件）\n2. 报告新的过期时间"
}
```

**发送目标**：讨论群的 chatId（从状态文件的 `chatId` 字段获取）。如果 chatId 为空，跳过发送，仅更新 `disbandRequested`。

### Step 4: 更新 disbandRequested 时间戳

对每个已发送解散申请的 PR：

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts mark-disband {prNumber}
```

更新 `disbandRequested` 为当前时间戳。

## 解散确认处理流程

当用户点击「确认解散」按钮时：

### 前置检查

1. 读取状态文件 `.temp-chats/pr-{prNumber}.json`
2. 检查 `state` 字段：
   - `state` ≠ `reviewing` → **拒绝解散**，告知用户当前状态不适合解散
   - `state` = `reviewing` → 继续

### 执行解散

```bash
npx tsx schedules/discussion-lifecycle/lifecycle.ts disband {prNumber}
```

该命令会：
1. 移除 `pr-scanner:reviewing` label
2. 通过 lark-cli 解散群组（DELETE /open-apis/im/v1/chats/{chatId}）
3. 删除状态文件

### 结果报告

向用户报告解散结果：
- ✅ 群组已解散 + label 已移除 + 状态文件已删除
- ⚠️ 群组解散失败但其他操作完成
- ❌ 解散失败，请手动处理

## 延长 24h 处理流程

当用户点击「延长 24h」按钮时：

1. 读取状态文件
2. 将 `expiresAt` 更新为 `now + 24h`
3. 将 `disbandRequested` 重置为 `null`
4. 原子写入状态文件
5. 向用户报告新的过期时间

## 状态转换

| 当前状态 | 条件 | 执行动作 | 新状态 |
|----------|------|----------|--------|
| `reviewing` + 已过期 | disbandRequested = null 或 ≥ 24h | 发送解散卡片 + 更新 disbandRequested | `reviewing`（不变） |
| `reviewing` + 已过期 | 用户确认解散 | 移除 label + 解散群组 + 删除文件 | （文件移除） |
| `reviewing` + 已过期 | 用户延长 24h | 更新 expiresAt + 清空 disbandRequested | `reviewing`（继续） |
| `approved`/`closed` + 已过期 | — | **跳过**（不处理非 reviewing 状态） | — |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| lark-cli 不可用 | Step 1 跳过检查（SKIP_LARK_CHECK=1），仅到 disband 时才需要 |
| 群组解散失败 | 记录警告，继续删除状态文件（群组可能已被手动解散） |
| 状态文件损坏 | 记录警告，跳过该文件 |
| GitHub Label 移除失败 | 记录警告，不影响解散流程 |
| chatId 为空 | 跳过发送卡片，仍更新 disbandRequested |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用（24h 内不重复发送解散卡片）
2. **有限处理**: 每次执行扫描所有过期 PR，但不强制解散（需用户确认）
3. **无状态**: Schedule 不维护内存状态，所有状态从文件读取
4. **状态校验**: 只有 `reviewing` 状态的 PR 才会触发解散流程
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只处理 `.temp-chats/` 目录下的文件

## 验收标准

- [ ] 过期 PR 被正确识别（`now > expiresAt`）
- [ ] 解散申请卡片 24h 内不重复发送
- [ ] `state` ≠ `reviewing` 时拒绝解散
- [ ] 确认解散后正确清理（群组 + 状态文件 + label）
- [ ] 群组解散失败不影响状态文件删除
- [ ] 无过期 PR 时正常退出

## 关联

- Parent: #2210
- Depends on: #2219, #2220
- Related: #2221
