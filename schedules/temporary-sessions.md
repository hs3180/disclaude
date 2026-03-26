---
name: "Temporary Sessions"
cron: "0 */5 * * * *"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-03-27T00:00:00.000Z"
---

# Temporary Session Manager

定期扫描 `workspace/temporary-sessions/` 目录中的会话文件，管理会话生命周期：
- **pending** → 创建群聊并发送卡片 → **active**
- **active** → 超时检查 → **expired**
- 清理已过期超过 24 小时的会话文件

## 会话状态流转

```
pending → active → expired
              ↘ (timeout)
```

| 状态 | 含义 | 触发条件 |
|------|------|----------|
| `pending` | 等待群聊创建 | 调用方创建会话文件 |
| `active` | 群聊已创建，等待用户响应 | 管理模块完成群聊创建+发送消息 |
| `expired` | 会话结束 | 用户响应 OR 超时 |

## 执行步骤

### 1. 检查会话目录

```bash
ls workspace/temporary-sessions/*.json 2>/dev/null | head -20 || echo "No sessions"
```

如果没有会话文件，**退出本次执行**。

### 2. 处理 pending 会话

对于每个 `status: "pending"` 的会话：

#### 2.1 创建群聊

使用 `start_group_discussion` 工具创建群聊：

```json
{
  "topic": "{session.createGroup.name}",
  "members": "{session.createGroup.members}",
  "context": "{session.message}"
}
```

**注意**：
- 如果 `createGroup` 为 null，则使用当前 `chatId` 发送消息（不创建新群聊）
- 如果创建群聊失败，记录错误并跳过该会话

#### 2.2 发送交互卡片

在群聊（或当前 chatId）中发送交互卡片：

**卡片内容**（format: "card"）：
根据 `session.options` 动态生成按钮，或使用默认按钮。

**actionPrompts**：
每个选项的 action prompt 应包含以下格式：
```
[用户操作] 用户在会话 {sessionId} 中选择了 "{{actionText}}" ({{actionValue}})。
请执行以下步骤：
1. 读取会话文件 workspace/temporary-sessions/{sessionId}.json
2. 更新会话状态为 expired，记录响应信息（selectedValue, responder, repliedAt）
3. 根据 session.context 中的信息执行后续操作
```

#### 2.3 更新会话状态

群聊创建和消息发送成功后，更新会话文件：

```bash
# 读取会话文件
cat workspace/temporary-sessions/{sessionId}.json

# 更新状态为 active，填入 chatId 和 messageId
# 使用 jq 或手动编辑 JSON 文件，设置：
# - status: "active"
# - chatId: "{新建群聊的 chatId}"
# - messageId: "{发送消息的 messageId}"
# - updatedAt: "{当前时间 ISO 格式}"
```

### 3. 处理 active 会话（超时检查）

对于每个 `status: "active"` 的会话：

```bash
# 检查是否超时
# 比较 session.expiresAt 与当前时间
# 如果 session.expiresAt 为 null，默认超时时间为创建后 60 分钟
```

如果超时：
- 更新会话状态为 `expired`（不记录 response）
- 根据 `session.context` 执行超时处理逻辑

### 4. 清理过期会话

删除已过期超过 24 小时的会话文件：

```bash
# 查找超过 24 小时的 expired 会话
# 删除对应的 JSON 文件
```

## 会话文件格式 (JSON)

```json
{
  "id": "pr-123",
  "status": "pending",
  "chatId": null,
  "messageId": null,
  "expiresAt": "2026-03-28T10:00:00Z",
  "updatedAt": "2026-03-27T10:00:00.000Z",
  "createdAt": "2026-03-27T10:00:00.000Z",
  "createGroup": {
    "name": "PR #123: Fix auth bug",
    "members": ["ou_developer", "ou_reviewer1"]
  },
  "message": "🔔 PR 审核请求\n**PR #123**: Fix authentication bug",
  "options": [
    {"value": "merge", "text": "✅ 合并"},
    {"value": "close", "text": "❌ 关闭"},
    {"value": "wait", "text": "⏳ 等待"}
  ],
  "context": {"prNumber": 123, "repository": "hs3180/disclaude"},
  "response": null
}
```

## 调用方使用方式

其他 Skill 或 Agent 可以通过以下方式创建会话：

1. 在 `workspace/temporary-sessions/` 目录下创建一个 JSON 文件
2. 设置 `status: "pending"` 并提供 `message`、`options`、`context`
3. 本 Schedule 会自动创建群聊、发送卡片、等待响应
4. 调用方定期检查会话文件，当 `status` 变为 `expired` 时处理结果

## 错误处理

1. 如果群聊创建失败，保留会话为 `pending`，下次执行时重试
2. 如果消息发送失败，保留会话为 `pending`，下次执行时重试
3. 如果会话文件格式损坏，跳过该文件并记录警告
4. 清理操作失败不影响主流程

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的默认群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整检查间隔（默认 5 分钟）

## 依赖

- MCP Tool: `start_group_discussion`（用于创建群聊）
- MCP Tool: `send_message`（用于发送交互卡片）
- 文件系统: `workspace/temporary-sessions/` 目录
