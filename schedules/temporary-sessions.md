---
name: "临时会话管理"
cron: "0 */5 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-04-01T00:00:00.000Z"
---

# 临时会话自动管理

每 5 分钟检查并处理临时会话生命周期：激活 pending 会话、清理过期会话。

## 执行步骤

### 1. 检查是否有 pending 会话需要激活

```bash
ls workspace/sessions/pending/ 2>/dev/null
```

如果没有文件，跳到步骤 3。

### 2. 激活 pending 会话

对每个 pending session 文件：

#### 2.1 读取 session 文件

```bash
cat workspace/sessions/pending/{sessionId}.json
```

#### 2.2 创建群聊

调用 `create_chat` MCP 工具：

```
create_chat({
  name: session.createGroup.name,
  description: session.createGroup.description,
  memberIds: session.createGroup.members
})
```

如果返回 `success: false`，记录错误并跳过该 session（保持 pending 状态，下次重试）。

#### 2.3 注册临时会话生命周期

使用 `create_chat` 返回的 `chatId`，调用 `register_temp_chat`：

```
register_temp_chat({
  chatId: "<从 create_chat 获取的 chatId>",
  expiresAt: session.expiresAt,
  context: { sessionId: session.id }
})
```

#### 2.4 发送交互卡片

调用 `send_interactive` MCP 工具发送卡片到新创建的群聊：

```
send_interactive({
  chatId: "<从 create_chat 获取的 chatId>",
  question: session.message,
  options: session.options,
  title: session.createGroup.name,
  actionPrompts: {
    "<option1.value>": "[临时会话 " + session.id + "] 用户选择了 {{actionText}}。会话 ID: " + session.id + "，请根据选择执行相应操作。",
    "<option2.value>": "[临时会话 " + session.id + "] 用户选择了 {{actionText}}。会话 ID: " + session.id + "，请根据选择执行相应操作。"
  }
})
```

**重要**：为每个 option 都生成对应的 actionPrompt，格式为 `[临时会话 {sessionId}] 用户选择了 {{actionText}}`。

#### 2.5 更新 session 状态

使用 Bash 更新 session 文件：

1. 更新文件内容：设置 `status` 为 `active`，`chatId` 为实际值，`activatedAt` 为当前时间
2. 移动文件：

```bash
# 更新 session 文件并移动到 active 目录
mkdir -p workspace/sessions/active
cat workspace/sessions/pending/{sessionId}.json | \
  jq '.status = "active" | .chatId = "<chatId>" | .activatedAt = "<currentISOTime>"' \
  > workspace/sessions/active/{sessionId}.json && \
rm workspace/sessions/pending/{sessionId}.json
```

如果 `jq` 不可用，使用 `sed` 或手动重写文件。

**每次执行只激活一个 pending session**（避免并发问题）。如果激活成功且还有更多 pending session，也继续处理（串行）。

### 3. 检查并处理过期会话

```bash
ls workspace/sessions/active/ 2>/dev/null
```

对每个 active session 文件：

#### 3.1 检查是否过期

```bash
# 使用 jq 检查 expiresAt 是否早于当前时间
cat workspace/sessions/active/{sessionId}.json | jq -r '.expiresAt'
```

如果 `expiresAt` < 当前时间，则该 session 已过期。

#### 3.2 处理过期 session

**注意**：`TempChatLifecycleService` 已经会自动调用 `dissolve_chat`，所以这里只需要更新文件状态。

```bash
mkdir -p workspace/sessions/expired
mv workspace/sessions/active/{sessionId}.json workspace/sessions/expired/{sessionId}.json
```

使用 `jq` 或手动更新 `status` 为 `expired`。

### 4. 清理已过期的 expired 会话文件

删除超过 7 天的 expired session 文件：

```bash
find workspace/sessions/expired/ -name "*.json" -mtime +7 -delete 2>/dev/null
```

---

## 状态管理

### 状态转换

```
pending ──(Schedule 激活)──► active ──(过期/响应完成)──► expired ──(7天后)──► 删除
```

### 目录用途

| 目录 | 用途 | 说明 |
|------|------|------|
| `pending/` | 等待激活 | Skill 创建的 session 文件 |
| `active/` | 已激活 | 群组已创建，等待用户响应或过期 |
| `expired/` | 已过期 | 群组已解散，保留记录 |

## 错误处理

- **create_chat 失败**: 保持 session 在 pending，下次重试
- **register_temp_chat 失败**: 仍然发送卡片，但记录警告（TempChatLifecycleService 不会自动清理）
- **send_interactive 失败**: 仍然标记为 active（群组已创建），但记录错误
- **session 文件格式错误**: 跳过并记录警告
- **目录不存在**: 首次运行时自动创建

## 依赖

- MCP Tools: `create_chat`, `register_temp_chat`, `send_interactive`
- CLI tools: `jq` (optional, 用于 JSON 操作)
- directories: `workspace/sessions/{pending,active,expired}/`

## 注意事项

1. **串行处理**: 一次只激活一个 session，避免并发问题
2. **幂等设计**: 每次执行可以安全重复运行，不会重复创建群组
3. **容错**: 单个 session 失败不影响其他 session 的处理
4. **自动清理**: `TempChatLifecycleService` 负责群组解散，本 Schedule 只负责文件状态管理
