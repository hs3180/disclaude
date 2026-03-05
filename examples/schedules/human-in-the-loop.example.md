---
name: "Human-in-the-Loop Example"
cron: "0 0 10 * * *"  # 每天上午 10 点执行
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# Human-in-the-Loop 示例 - 交互式问答

本示例展示如何使用 `send_user_feedback` 和 `wait_for_interaction` 实现 Agent 主动询问人类的功能。

## 背景

Issue #532: Human-in-the-Loop 交互系统

在某些场景下，Agent 需要向用户提问并等待响应，例如：
- PR Review：询问如何处理一个 PR（合并/关闭/请求修改）
- 决策确认：在执行重要操作前请求用户确认
- 选项收集：让用户从多个选项中选择

## 核心工具

### 1. send_user_feedback
发送消息到飞书群聊，支持文本和交互式卡片格式。

```typescript
// 发送文本消息
send_user_feedback({
  content: "Hello, world!",
  chatId: "oc_xxx",
  format: "text"
})

// 发送交互式卡片
send_user_feedback({
  content: {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "请选择操作" },
      template: "blue"
    },
    elements: [
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "确认" },
            type: "primary",
            value: "confirm"
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "取消" },
            type: "default",
            value: "cancel"
          }
        ]
      }
    ]
  },
  chatId: "oc_xxx",
  format: "card"
})
```

### 2. wait_for_interaction
等待用户与卡片交互（点击按钮、选择菜单等）。

```typescript
const result = await wait_for_interaction({
  messageId: "om_xxx",  // 卡片消息的 ID
  chatId: "oc_xxx",
  timeoutSeconds: 300   // 最长等待 5 分钟
})

if (result.success) {
  console.log(`用户 ${result.userId} 选择了: ${result.actionValue}`)
}
```

### 3. update_card
更新已发送的卡片内容。

```typescript
await update_card({
  messageId: "om_xxx",
  chatId: "oc_xxx",
  card: {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "操作已完成" },
      template: "green"
    },
    elements: [
      { tag: "markdown", content: "✅ 您选择了确认操作" }
    ]
  }
})
```

## 完整工作流示例

### 场景：PR 处理决策

```markdown
## 执行步骤

### 1. 发送问题卡片

使用 send_user_feedback 发送一个带按钮的交互式卡片：

- 卡片标题: "PR #123 需要处理"
- 卡片内容: PR 详细信息
- 操作按钮: [合并] [关闭] [请求修改] [稍后处理]

记录返回的 messageId 用于后续等待。

### 2. 等待用户选择

使用 wait_for_interaction 等待用户点击按钮：

- 设置超时时间（如 5 分钟）
- 如果用户响应，获取 actionValue
- 如果超时，提示用户并结束

### 3. 根据选择执行操作

根据 actionValue 执行对应操作：

| actionValue | 操作 |
|-------------|------|
| merge | 执行 `gh pr merge` |
| close | 执行 `gh pr close` |
| request_changes | 添加评论请求修改 |
| later | 记录到待处理列表 |

### 4. 更新卡片状态

使用 update_card 更新卡片显示结果。
```

## 注意事项

1. **超时处理**: wait_for_interaction 默认超时 5 分钟，可以根据需要调整
2. **阻塞执行**: 当前实现是同步阻塞的，Agent 会等待用户响应
3. **单次等待**: 同一消息只能有一个等待中的交互
4. **CLI 模式**: 在 CLI 模式下会模拟立即响应

## 使用说明

1. 复制此文件到 `workspace/schedules/` 目录
2. 修改 `chatId` 为目标群聊 ID
3. 根据实际需求修改卡片内容和处理逻辑
4. 设置 `enabled: true` 启用任务

## 验收标准 (Issue #532)

- [x] Agent 能发送带选项的提问卡片 - send_user_feedback(format: "card")
- [x] 用户选择后 Agent 能收到回复 - wait_for_interaction()
- [x] Agent 能根据用户选择继续执行 - 流程控制
- [ ] #393 PR 扫描群聊讨论流程跑通 - 待集成测试
