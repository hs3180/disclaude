---
name: "Temporary Sessions"
cron: "*/10 * * * *"
enabled: true
blocking: true
---

# Temporary Sessions Manager

管理临时会话的生命周期：创建群聊、发送消息、处理超时。

## 相关 Issue

- #393 PR Scanner - 定时扫描 PR 并创建讨论群聊
- #631 离线提问 - Agent 不阻塞工作的留言机制
- #946 御书房 - AI 请求 review 时的丝滑体验

## 核心职责

1. 处理 `status=pending` 的会话（创建群聊 + 发送消息）
2. 处理 `status=active` 的会话（检查超时）
3. **不处理群聊创建**（需要用户提供现有 chatId）

## 设计说明

根据 Issue #1391 的反馈，本 schedule **不负责自动创建群聊**。

调用方需要：
1. 在创建会话文件时提供 `chatId`（使用现有的群聊）
2. 或者先手动创建群聊，再使用该 chatId

## 会话文件位置

```
workspace/temporary-sessions/*.yaml
```

## 会话文件格式

```yaml
# === 状态 ===
status: pending           # pending → active → expired
chatId: oc_xxx           # 必须提供（使用现有群聊）
messageId: null          # 消息发送后填充
expiresAt: 2026-03-11T10:00:00Z

# === 消息内容 ===
message: |
  # 🔔 PR 审核请求

  **PR #123**: Fix authentication bug

options:
  - value: merge
    text: "✓ 合并"
  - value: close
    text: "✗ 关闭"

# === 上下文 ===
context:
  prNumber: 123
  repository: hs3180/disclaude

# === 响应 ===
response: null
```

## 执行步骤

### 1. 检查会话目录

```bash
ls workspace/temporary-sessions/*.yaml 2>/dev/null || echo "No sessions"
```

如果没有会话文件，本次执行结束。

### 2. 处理 pending 状态的会话

对于每个 `status: pending` 的会话：

1. 读取会话文件
2. **验证 chatId**： 如果没有提供 chatId，标记为错误并跳过
3. 使用 `mcp__channel-mcp__send_interactive` 发送交互卡片到指定 chatId
4. 更新会话文件：
   - `status: active`
   - `messageId: <发送后的消息ID>`

**卡片格式**：
```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "🔔 临时会话请求", "tag": "plain_text"}, "template": "blue"},
    "elements": [
      {"tag": "markdown", "content": "<message内容>"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "选项1", "tag": "plain_text"}, "value": "option1", "type": "primary"},
        {"tag": "button", "text": {"content": "选项2", "tag": "plain_text"}, "value": "option2", "type": "default"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "<chatId>",
  "actionPrompts": {
    "option1": "[用户响应] 用户选择了选项1",
    "option2": "[用户响应] 用户选择了选项2"
  }
}
```

### 3. 处理 active 状态的会话

对于每个 `status: active` 的会话：

1. 读取会话文件
2. 检查是否超过 `expiresAt`
3. 如果超时：
   - 更新 `status: expired`
   - 可选： 发送超时通知到 chatId

### 4. 处理用户响应（通过卡片回调）

当用户点击卡片按钮时，会话文件会被外部回调处理器更新：

```yaml
status: expired
response:
  selectedValue: merge
  responder: ou_xxx
  repliedAt: 2026-03-10T14:30:00Z
```

## 工具函数

### 读取会话文件

```bash
# 读取 YAML 文件内容
cat workspace/temporary-sessions/<session-id>.yaml
```

### 写入会话文件

```bash
# 使用 Write 工具更新 YAML 文件
```

### 解析 YAML

手动解析 YAML frontmatter 和内容（使用简单的文本处理）。

## 错误处理

- 会话文件格式错误 → 记录错误并跳过
- chatId 缺失 → 标记为错误并跳过
- 发送消息失败 → 记录错误，保持 pending 状态以便重试
- 超时检查失败 → 记录错误，下次继续检查

## 注意事项

1. **不创建新群聊**: 舟要 id 需要由调用方提供
2. **无状态设计**: 每次执行都是独立的，从文件读取状态
3. **幂等操作**: 重复执行不会产生副作用
4. **简单轮询**: 检查间隔为 10 秒

## 调用方使用示例

```typescript
// 创建临时会话（使用现有群聊）
writeYAML('workspace/temporary-sessions/pr-123.yaml', {
  status: 'pending',
  chatId: 'oc_existing_group_xxx',  // 使用现有群聊
  messageId: null,
  expiresAt: '2026-03-11T10:00:00Z',
  message: '请审核 PR #123',
  options: [
    { value: 'merge', text: '✓ 合并' },
    { value: 'close', text: '✗ 关闭' }
  ],
  context: { prNumber: 123 },
  response: null
});

// 在其他 schedule 中轮询结果
const session = readYAML('workspace/temporary-sessions/pr-123.yaml');
if (session.status === 'expired') {
  if (session.response) {
    console.log('用户选择了:', session.response.selectedValue);
  } else {
    console.log('会话超时未响应');
  }
}
```
