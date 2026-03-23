---
name: "Temporary Sessions Manager"
cron: "0 */5 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Temporary Sessions Manager

管理临时会话的生命周期：创建群聊、发送交互卡片、处理超时。

## 执行步骤

### 1. 扫描 pending 会话

检查 `workspace/temporary-sessions/` 目录下的所有 JSON 文件：

```bash
ls workspace/temporary-sessions/*.json 2>/dev/null
```

如果目录不存在或为空，退出本次执行。

### 2. 读取并分类所有会话

对每个 JSON 文件，读取内容并按状态分类：

- **pending**: 需要创建群聊并发送消息
- **active**: 需要检查是否超时
- **expired**: 无需处理（调用方自行清理）

```bash
# 获取所有 pending 会话
cat workspace/temporary-sessions/*.json | jq -s '[.[] | select(.status == "pending")]'

# 获取所有 active 会话
cat workspace/temporary-sessions/*.json | jq -s '[.[] | select(.status == "active")]'
```

### 3. 处理 pending 会话 ⚡ 核心

对于每个 `status=pending` 的会话：

#### 3.1 检查是否已超时

如果 `expiresAt < 当前时间`，直接标记为 expired：

```bash
# 将超时的 pending 会话标记为 expired
jq '.status = "expired" | .updatedAt = "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"' session.json > session.json.tmp && mv session.json.tmp session.json
```

#### 3.2 创建群聊

使用 `start_group_discussion` 工具创建群聊：

```json
{
  "topic": "{createGroup.name}",
  "members": "{createGroup.members}",
  "context": "{message}",
  "timeout": 60
}
```

**注意**：
- 如果会话没有 `createGroup` 字段，则跳过群聊创建，直接使用现有 chatId
- `members` 为空时，只邀请当前用户

#### 3.3 发送交互卡片

群聊创建后，在群聊中发送交互式卡片（format: "card"）：

**卡片内容**：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "📋 请选择操作", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "{message}"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      // 为每个 option 生成一个按钮
      {"tag": "button", "text": {"content": "{option.text}", "tag": "plain_text"}, "value": "{option.value}"}
    ]}
  ]
}
```

**actionPrompts**（为每个 option 生成一个 prompt）：
```json
{
  "{option.value}": "[用户操作] 用户选择了「{option.text}」。\n\n会话ID: {session.id}\n\n请执行以下操作：\n1. 更新会话文件，将 status 设为 expired，response 设为 {{selectedValue: \"{option.value}\", responder: \"用户\", repliedAt: \"当前时间\"}}\n2. 根据 context 中的信息处理用户的响应"
}
```

#### 3.4 更新会话状态

群聊创建和卡片发送成功后，更新会话文件：

```bash
jq '.status = "active" | .chatId = "{新群聊ID}" | .messageId = "{卡片消息ID}" | .updatedAt = "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"' workspace/temporary-sessions/{session.id}.json > /tmp/session.tmp && mv /tmp/session.tmp workspace/temporary-sessions/{session.id}.json
```

### 4. 处理 active 会话超时

对于每个 `status=active` 的会话，检查是否超时：

```bash
# 检查是否超时（使用 jq 比较 ISO 时间戳）
jq -r '.expiresAt' workspace/temporary-sessions/{session.id}.json
```

如果 `expiresAt < 当前时间`：
1. 标记会话为 expired（response 保持 null）
2. 可选：在群聊中发送超时通知

```bash
jq '.status = "expired" | .updatedAt = "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"' workspace/temporary-sessions/{session.id}.json > /tmp/session.tmp && mv /tmp/session.tmp workspace/temporary-sessions/{session.id}.json
```

## 执行限制

- 每次执行最多处理 **3 个** pending 会话，避免一次性创建过多群聊
- 按创建时间排序，优先处理最早创建的会话
- 如果创建群聊失败，跳过该会话，下次执行时重试

## 错误处理

- 如果群聊创建失败，记录错误但不影响其他会话
- 如果卡片发送失败，记录错误但不影响其他会话
- 如果文件读取失败（格式错误），跳过该文件
- 如果会话文件被删除（已被调用方清理），跳过

## 相关文件

- 会话目录: `workspace/temporary-sessions/`
- 相关 Issue: #1391
- 关联 Issue: #393, #631, #946
