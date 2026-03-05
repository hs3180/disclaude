---
name: "PR Scanner"
cron: "0 */30 * * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# PR Scanner - Phase 1

定期扫描仓库的 open PR，发现新 PR 时发送通知到指定群聊。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 30 分钟
- **通知目标**: 配置的 chatId

## 执行步骤

### 1. 获取当前 open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open --json number,title,author,updatedAt
```

### 2. 读取历史记录

读取 `workspace/pr-scanner-history.json` 文件，获取已处理的 PR 列表。

如果文件不存在，创建初始结构：
```json
{
  "lastScan": "",
  "processedPRs": [],
  "prChats": {}
}
```

### 3. 识别新 PR

对比当前 open PR 与历史记录，找出新增的 PR。

### 4. 处理每个新 PR

对于每个新 PR：

1. 获取详细信息：
   ```bash
   gh pr view {number} --repo hs3180/disclaude
   ```

2. 使用 `send_user_feedback` 发送通知：
   - PR 标题和编号
   - 作者
   - 状态（可合并/有冲突）
   - CI 检查状态
   - 链接

3. 更新历史记录

### 5. 更新历史文件

将处理过的 PR 编号添加到 `processedPRs` 数组，更新 `lastScan` 时间戳。

## 通知消息模板

```
🔔 新 PR 检测到

PR #{number}: {title}

👤 作者: {author}
📊 状态: {mergeable ? '✅ 可合并' : '⚠️ 有冲突'}
🔍 检查: {ciStatus}

📋 描述:
{description}

🔗 链接: https://github.com/hs3180/disclaude/pull/{number}
```

## 错误处理

- 如果 `gh` 命令失败，记录错误并发送错误通知
- 如果历史文件损坏，重置并重新开始
- 如果发送通知失败，记录错误但继续处理其他 PR

## 使用说明

1. 复制此文件到 `workspace/schedules/pr-scanner.md`
2. 替换 `chatId` 为实际的飞书群聊 ID
3. 设置 `enabled: true`
4. 调度器将自动加载并执行

## Phase 2: 交互式操作 (可选)

如果需要在通知后等待用户决策，可以使用交互式卡片：

### 交互式卡片模板

```json
{
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "tag": "plain_text", content": "🔔 新 PR 检测到" },
    "template": "blue"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "**PR #{number}: {title}**\n\n👤 作者: {author}\n📊 状态: {status}\n🔗 [查看详情]({link})"
    },
    {
      "tag": "action",
      "actions": [
        {
          "tag": "button",
          "text": { "tag": "plain_text", "content": "合并" },
          "type": "primary",
          "value": "merge_{number}"
        },
        {
          "tag": "button",
          "text": { "tag": "plain_text", "content": "关闭" },
          "type": "danger",
          "value": "close_{number}"
        },
        {
          "tag": "button",
          "text": { "tag": "plain_text", "content": "请求修改" },
          "type": "default",
          "value": "request_changes_{number}"
        },
        {
          "tag": "button",
          "text": { "tag": "plain_text", "content": "稍后处理" },
          "type": "default",
          "value": "later_{number}"
        }
      ]
    }
  ]
}
```

### 等待用户交互

发送卡片后，使用 `wait_for_interaction` 等待用户选择：

```typescript
// 1. 发送交互式卡片，记录 messageId
const sendResult = await send_user_feedback({
  content: cardContent,
  chatId: "oc_xxx",
  format: "card"
})

// 2. 等待用户交互（最长 5 分钟）
const interaction = await wait_for_interaction({
  messageId: sendResult.messageId,
  chatId: "oc_xxx",
  timeoutSeconds: 300
})

// 3. 根据用户选择执行操作
if (interaction.success) {
  const [action, prNumber] = interaction.actionValue.split('_')

  switch (action) {
    case 'merge':
      await execute_command(`gh pr merge ${prNumber} --squash`)
      break
    case 'close':
      await execute_command(`gh pr close ${prNumber}`)
      break
    case 'request_changes':
      // 添加评论请求修改
      break
    case 'later':
      // 记录到待处理列表
      break
  }

  // 4. 更新卡片显示结果
  await update_card({
    messageId: sendResult.messageId,
    chatId: "oc_xxx",
    card: { /* 结果卡片 */ }
  })
}
```

## 实现状态

| Phase | 功能 | 状态 |
|-------|------|------|
| Phase 1 | 基本扫描 + 通知 | ✅ 可用 |
| Phase 2 | 交互式操作按钮 | ✅ 可用 (使用 wait_for_interaction) |

## 相关 Issue

- Issue #393: 定时扫描 PR 并创建讨论群聊
- Issue #532: Human-in-the-Loop 交互系统
- PR #423: ChatOps 工具函数（已合并）
- PR #350: wait_for_interaction 工具（已合并）
