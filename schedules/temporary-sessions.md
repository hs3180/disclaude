---
name: "Temporary Session Lifecycle Manager"
cron: "0 */5 * * * *"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-03-31T00:00:00.000Z"
---

# Temporary Session Lifecycle Manager

自动管理临时会话的生命周期：激活 pending 会话、检查超时、清理过期会话。

## 执行间隔

每 5 分钟执行一次。

## 执行步骤

### Step 1: 检查会话目录

```bash
ls workspace/sessions/*.json 2>/dev/null || echo "NO_SESSIONS"
```

如果没有会话文件，输出以下消息并结束：
```
📋 临时会话管理: 暂无会话文件
```

### Step 2: 读取所有会话文件

使用 `Read` 工具读取 `workspace/sessions/` 目录下的所有 `.json` 文件。

将所有会话按状态分类：
- **pending**: 等待激活
- **active**: 等待响应
- **expired**: 等待清理
- **resolved**: 等待清理

### Step 3: 激活 pending 会话

对每个 `status: "pending"` 的会话：

#### 3.1 创建群组

调用 `create_chat` MCP 工具：
```json
{
  "name": "{createGroup.name}",
  "description": "{createGroup.description}",
  "memberIds": "{createGroup.memberIds}"
}
```

**如果创建失败**：跳过该会话，记录错误信息，不更新状态（下次重试）。

#### 3.2 注册临时会话

调用 `register_temp_chat` MCP 工具：
```json
{
  "chatId": "{从 create_chat 返回的 chatId}",
  "expiresAt": "{expiresAt}",
  "context": "{session.context}"
}
```

#### 3.3 发送交互卡片到群组

使用 `send_user_feedback` 工具向新建群组发送交互卡片（format: "card"）。

**卡片内容**：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "{message.title}"},
    "template": "blue"
  },
  "elements": [
    {"tag": "markdown", "content": "{message.body}"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"tag": "plain_text", "content": "{option1.text}"}, "value": "session-{id}-{option1.value}", "type": "primary"},
      {"tag": "button", "text": {"tag": "plain_text", "content": "{option2.text}"}, "value": "session-{id}-{option2.value}"}
    ]}
  ]
}
```

**actionPrompts**（为每个选项生成）：
```json
{
  "session-{id}-{option.value}": "[用户操作] 用户在会话 {id} 中选择了「{option.text}」。请更新会话状态为 resolved，记录响应选项和响应时间。"
}
```

**注意**：
- `send_user_feedback` 的 `chatId` 参数必须使用 **新创建的群组 chatId**
- 按钮的 `value` 必须包含 session ID 前缀，格式为 `session-{sessionId}-{optionValue}`
- 如果 `message.options` 有 3+ 个选项，第一个用 `primary`，其余用 `default`

#### 3.4 更新会话状态

使用 `Edit` 工具更新会话文件：
- 将 `status` 从 `"pending"` 改为 `"active"`
- 将 `chatId` 设置为从 `create_chat` 返回的值
- 将 `activatedAt` 设置为当前时间（ISO 8601）

### Step 4: 检查并过期超时的 active 会话

对每个 `status: "active"` 的会话：

```bash
# 检查是否过期（比较 expiresAt 和当前时间）
current_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# 在会话文件中检查 expiresAt 字段
```

如果 `expiresAt` < 当前时间：

#### 4.1 解散群组

调用 `dissolve_chat` MCP 工具：
```json
{
  "chatId": "{chatId}"
}
```

**如果解散失败**：记录错误但仍然更新状态（避免重复尝试）。

#### 4.2 更新会话状态

使用 `Edit` 工具更新会话文件：
- 将 `status` 从 `"active"` 改为 `"expired"`
- 在 `response` 字段记录过期信息：
  ```json
  {
    "option": "timeout",
    "respondedAt": "{current_time}",
    "note": "Auto-expired by schedule"
  }
  ```

### Step 5: 清理过期的 resolved 和 expired 会话

对每个 `status: "resolved"` 或 `status: "expired"` 的会话：

检查是否超过清理宽限期（24 小时）：
- 如果 `response.respondedAt` 超过 24 小时 → 删除会话文件
- 否则 → 保留（等待人工检查）

```bash
# 对于 resolved 会话：检查 respondedAt
# 对于 expired 会话：检查 response.respondedAt（即过期时间）
```

**清理条件**：会话状态为 `resolved` 或 `expired`，且响应/过期时间超过 24 小时。

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| 会话目录不存在 | 输出"暂无会话"并结束 |
| 会话文件格式错误 | 跳过该文件，记录错误 |
| `create_chat` 失败 | 保持 pending 状态，下次重试 |
| `dissolve_chat` 失败 | 仍标记为 expired，记录失败 |
| `register_temp_chat` 失败 | 不影响主流程，记录警告 |
| `send_user_feedback` 失败 | 保持 active 状态，下次重试 |

## 执行报告

每次执行后，输出简短报告：

```
📋 临时会话管理执行报告

- 激活: {N} 个 pending 会话
- 过期: {N} 个 active 会话（超时）
- 清理: {N} 个过期会话文件
- 错误: {N} 个（附详情）
```

## 依赖

- MCP Tools: `create_chat`, `dissolve_chat`, `register_temp_chat`
- 会话文件目录: `workspace/sessions/`
- `send_user_feedback` 工具（用于发送交互卡片）

## 重要提示

1. **不要创建新的定时任务** - 这是定时任务执行环境的规则
2. **不要修改现有的定时任务**
3. **只执行上述步骤，完成后结束**
4. **每次最多处理 10 个 pending 会话**，避免单次执行时间过长
5. **使用 `send_user_feedback` 发送卡片时，chatId 必须是新创建的群组 ID**
