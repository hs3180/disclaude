---
name: "Discussion Messenger"
cron: "30 * * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-04T00:00:00.000Z
---

# Discussion Messenger

向已激活的讨论群发送初始讨论提示，并通知发起讨论的原始群聊。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每 1 分钟（偏移 30 秒，与 chats-activation 错开）
- **每次最多处理**: 10 个

## 前置依赖

- `jq`（JSON 处理工具）
- `send_interactive` MCP 工具（用于发送卡片消息）

## 职责边界

- ✅ 检测新激活的 discussion 类型聊天
- ✅ 发送初始讨论提示到讨论群
- ✅ 通知原始群聊（sourceChatId）讨论已创建
- ✅ 标记已发送（防止重复发送）
- ❌ 不创建群组（由 `chats-activation` schedule 负责）
- ❌ 不处理用户回复（由消费方 skill 负责）
- ❌ 不解散群组（由 `chat-timeout` skill 负责）

## 执行步骤

### Step 1: 查找待发送的讨论聊天

遍历 `workspace/chats/*.json`，筛选满足以下条件的聊天：

1. `status` = `"active"`（群组已创建）
2. `context.type` = `"discussion"`（是讨论类型）
3. `context.initialMessageSent` 不存在或为 `false`（尚未发送初始消息）

```bash
# 列出待发送的讨论聊天
for f in workspace/chats/*.json; do
  jq -r 'select(.status == "active" and .context.type == "discussion" and (.context.initialMessageSent // false) == false) | "\(.id)|\(.chatId)|\(.context.topic // "未指定主题")"' "$f" 2>/dev/null
done
```

### Step 2: 发送初始讨论提示

对每个待发送的聊天：

1. **读取完整上下文** — 从 JSON 文件提取 `context.prompt`、`context.suggestedOptions`、`context.background`
2. **构造卡片消息** — 使用 `send_interactive` 发送格式化的讨论卡片
3. **发送到讨论群** — 使用 `chatId` 作为目标
4. **通知原始群聊**（如有 `sourceChatId`）— 发送简短通知

#### 卡片消息格式

向讨论群发送的初始消息应包含：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"content": "💬 讨论邀请", "tag": "plain_text"},
    "template": "blue"
  },
  "elements": [
    {"tag": "markdown", "content": "**主题**: {topic}\n\n**背景**: {background}\n\n{prompt}"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "⏰ 此讨论将在 24 小时后自动结束"}
  ]
}
```

#### 原始群通知格式

如果存在 `sourceChatId`，向原始群发送简短通知：

```
💬 已创建讨论群「{topic}」，请在群中参与讨论。
```

### Step 3: 标记已发送

发送成功后，更新聊天文件：

```bash
# 使用 jq 原子更新
jq '.context.initialMessageSent = true | .context.sentAt = (now | todate)' chat.json > chat.tmp && mv chat.tmp chat.json
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 聊天文件损坏（非 JSON） | 记录警告，跳过 |
| `chatId` 为空 | 跳过（群组尚未创建） |
| `context.prompt` 为空 | 使用 topic 作为简单消息 |
| MCP 发送失败 | 记录错误，下次重试（不标记为已发送） |
| 原始群通知失败 | 不影响讨论消息的标记（讨论群消息优先） |

## 注意事项

1. **幂等性**: 通过 `initialMessageSent` 标记防止重复发送
2. **时序保证**: 与 `chats-activation` 错开 30 秒执行，确保群组已创建
3. **原子更新**: 使用 `jq + mv` 模式原子更新 JSON 文件
4. **限流保护**: 每次最多处理 10 个聊天
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **仅处理 discussion 类型**: 通过 `context.type === "discussion"` 筛选，不影响其他聊天类型
