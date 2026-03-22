---
name: "Temporary Sessions"
cron: "*/10 * * * * *"
enabled: true
blocking: false
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Temporary Sessions - 临时会话管理

管理临时会话的生命周期：创建群聊、发送消息、检查超时。

@see Issue #1391 - 临时会话管理系统（简化版设计）

## 配置

- **扫描间隔**: 每 10 秒
- **会话目录**: `temporary-sessions/`
- **默认超时**: 60 分钟

## 执行步骤

### 1. 扫描 pending 状态的会话

```bash
# 列出所有 pending 状态的会话文件
ls -1 temporary-sessions/*.yaml 2>/dev/null | head -10
```

对于每个文件，检查 `status` 字段是否为 `pending`：

```bash
# 使用 grep 快速过滤 pending 状态
grep -l "^status: pending" temporary-sessions/*.yaml 2>/dev/null || echo "No pending sessions"
```

### 2. 处理 pending 会话 - 创建群聊并发送消息

对于每个 pending 会话：

#### 2.1 读取会话配置

```bash
# 读取会话文件内容
cat temporary-sessions/{session-id}.yaml
```

解析以下字段：
- `createGroup.name`: 群聊名称
- `createGroup.members`: 成员列表
- `message`: 消息内容
- `options`: 交互选项
- `context`: 上下文信息

#### 2.2 创建群聊

使用 `mcp__channel-mcp__create_group` 工具（如果可用）或通过代码实现：

```json
{
  "topic": "{createGroup.name}",
  "members": "{createGroup.members}"
}
```

如果创建成功，获取返回的 `chatId`。

#### 2.3 发送交互式卡片

使用 `mcp__channel-mcp__send_interactive` 工具：

```json
{
  "chatId": "{新创建的 chatId}",
  "card": {
    "config": { "wide_screen_mode": true },
    "header": {
      "title": { "content": "🔔 需要您的响应", "tag": "plain_text" },
      "template": "blue"
    },
    "elements": [
      { "tag": "markdown", "content": "{message}" },
      { "tag": "hr" },
      {
        "tag": "action",
        "actions": [
          { "tag": "button", "text": { "content": "{option1.text}", "tag": "plain_text" }, "value": "{option1.value}", "type": "primary" },
          { "tag": "button", "text": { "content": "{option2.text}", "tag": "plain_text" }, "value": "{option2.value}", "type": "default" }
        ]
      }
    ]
  },
  "actionPrompts": {
    "{option1.value}": "[用户响应] 用户选择了 {option1.text}。会话 ID: {session-id}",
    "{option2.value}": "[用户响应] 用户选择了 {option2.text}。会话 ID: {session-id}"
  }
}
```

#### 2.4 更新会话状态

更新 YAML 文件：

```yaml
status: active
chatId: {新创建的 chatId}
messageId: {发送的消息 ID}
```

### 3. 检查 active 会话的超时

对于每个 active 会话：

```bash
# 读取 expiresAt 字段
grep "^expiresAt:" temporary-sessions/{session-id}.yaml
```

比较当前时间与 `expiresAt`：
- 如果已超时，更新 `status: expired`（不设置 response）

### 4. 清理过期的会话文件（可选）

对于 expired 超过 24 小时的会话，可以选择删除文件：

```bash
# 检查 expired 时间（需要解析文件）
# 如果超过 24 小时，删除文件
```

## 会话文件格式

### 创建时（pending）

```yaml
status: pending
chatId: null
messageId: null
expiresAt: 2026-03-22T12:00:00Z

createGroup:
  name: "PR #123: Fix auth bug"
  members:
    - ou_developer

message: |
  # PR 审核请求
  **PR #123**: Fix authentication bug

options:
  - value: approve
    text: "✓ 批准"
  - value: reject
    text: "✗ 拒绝"

context:
  prNumber: 123
  source: pr-scanner
```

### 群聊创建后（active）

```yaml
status: active
chatId: oc_new_group_xxx
messageId: om_xxx
expiresAt: 2026-03-22T12:00:00Z
```

### 用户响应后（expired）

```yaml
status: expired
chatId: oc_new_group_xxx
messageId: om_xxx
expiresAt: 2026-03-22T12:00:00Z

response:
  selectedValue: approve
  responder: ou_developer
  respondedAt: 2026-03-22T11:30:00Z
```

## 回调处理器

当用户点击按钮时，回调处理器应该：

1. 根据 `messageId` 找到对应的会话文件
2. 更新会话状态：

```yaml
status: expired
response:
  selectedValue: {action.value}
  responder: {operator.open_id}
  respondedAt: {current timestamp}
```

3. 通知调用方（通过 `context.source` 确定来源）

## 错误处理

- 创建群聊失败：记录错误，保持 pending 状态，下次重试
- 发送消息失败：记录错误，可能需要手动干预
- 文件读写失败：记录错误，不影响其他会话

## 注意事项

1. **幂等性**: 每次执行都是幂等的，可以安全重试
2. **单文件结构**: 每个会话只需一个 YAML 文件
3. **轮询机制**: 调用方主动轮询检查响应，无回调
4. **超时处理**: 超时后 status 变为 expired，但 response 为 null

## 依赖

- `mcp__channel-mcp__send_interactive` - 发送交互式卡片
- `mcp__channel-mcp__send_text` - 发送纯文本消息
- YAML 文件读写能力
