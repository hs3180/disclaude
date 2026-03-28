---
name: "Temporary Sessions"
cron: "0 * * * * *"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-03-28T00:00:00.000Z"
---

# Temporary Sessions Manager

定期扫描临时会话文件，自动激活 pending 会话（创建群聊 + 发送卡片），超时后自动解散群聊。

## 执行步骤

### Step 1: 列出 pending sessions

```bash
ls workspace/temporary-sessions/*.yaml 2>/dev/null || echo "NO_SESSIONS"
```

如果输出为 `NO_SESSIONS` 或目录不存在，**退出本次执行**。

### Step 2: 筛选 pending 状态的 sessions

读取每个 YAML 文件，筛选出 `status: pending` 的会话：

```bash
grep -l "^status: pending" workspace/temporary-sessions/*.yaml 2>/dev/null || echo "NO_PENDING"
```

如果输出为 `NO_PENDING`，跳到 Step 3。

### Step 3: 激活每个 pending session ⚡ 核心步骤

对每个 pending session：

#### 3.1 读取 session 文件

```
Read workspace/temporary-sessions/{id}.yaml
```

提取以下字段：
- `id`: 会话标识
- `createGroup.name`: 群组名称
- `createGroup.members`: 成员列表
- `message`: 卡片消息内容
- `options`: 按钮选项列表
- `context`: 上下文信息
- `expiresAt`: 过期时间

#### 3.2 创建群聊

调用 `create_chat` MCP 工具：

```json
{
  "name": "{createGroup.name}",
  "memberIds": {createGroup.members}
}
```

**如果创建失败**（返回 `success: false`）：
- 记录错误日志
- **跳过该 session**，下次执行重试
- 继续处理下一个 pending session

**如果创建成功**：
- 记录返回的 `chatId`

#### 3.3 发送交互卡片

使用 `send_interactive` MCP 工具发送卡片到新创建的群聊：

```json
{
  "chatId": "{chatId from step 3.2}",
  "title": "{createGroup.name}",
  "question": "{message}",
  "context": "📋 Session: {id}\n⏰ Expires: {expiresAt}",
  "options": {options from session file},
  "actionPrompts": {
    "{option1.value}": "[临时会话响应] 会话 {id}：用户选择了「{option1.text}」。\n请执行以下操作：\n1. 读取 workspace/temporary-sessions/{id}.yaml\n2. 验证 status 为 active\n3. 将 status 更新为 expired\n4. 将 response 更新为：\n   selectedValue: \"{option1.value}\"\n   responder: 从 context 中获取\n   respondedAt: 当前时间 ISO 格式\n5. 根据 context 中的信息执行对应操作\n6. 将更新后的文件写回 workspace/temporary-sessions/{id}.yaml",
    "{option2.value}": "[临时会话响应] 会话 {id}：用户选择了「{option2.text}」。\n请执行以下操作：\n1. 读取 workspace/temporary-sessions/{id}.yaml\n2. 验证 status 为 active\n3. 将 status 更新为 expired\n4. 将 response 更新为：\n   selectedValue: \"{option2.value}\"\n   responder: 从 context 中获取\n   respondedAt: 当前时间 ISO 格式\n5. 根据 context 中的信息执行对应操作\n6. 将更新后的文件写回 workspace/temporary-sessions/{id}.yaml"
  }
}
```

**为每个 option 都生成对应的 actionPrompt**，确保所有按钮点击都能正确路由到 session 更新操作。

**如果发送失败**：
- 记录错误日志
- **跳过该 session**，下次执行重试
- 群聊已创建但卡片未发送，下次重试时需要处理（见下方错误恢复）

#### 3.4 更新 session 状态为 active

使用 Edit 工具更新 session 文件：

```yaml
status: active
chatId: {chatId from step 3.2}
messageId: {如果 send_interactive 返回了 messageId}
```

### Step 4: 检查超时的 active sessions

#### 4.1 筛选 active 状态的 sessions

```bash
grep -l "^status: active" workspace/temporary-sessions/*.yaml 2>/dev/null || echo "NO_ACTIVE"
```

如果输出为 `NO_ACTIVE`，跳到 Step 5。

#### 4.2 检查每个 active session 是否超时

读取 session 文件，比较 `expiresAt` 与当前时间：

```bash
# 获取当前时间戳（ISO 格式）
date -u +"%Y-%m-%dT%H:%M:%SZ"
```

如果当前时间 > `expiresAt`，则该 session 已超时。

#### 4.3 解散超时 session 的群聊

调用 `dissolve_chat` MCP 工具：

```json
{
  "chatId": "{session.chatId}"
}
```

**如果解散失败**：
- 记录错误日志
- 仍然将 session 标记为 expired（避免无限重试）
- 继续处理下一个超时 session

#### 4.4 更新 session 状态为 expired

使用 Edit 工具更新 session 文件：

```yaml
status: expired
response: null
```

### Step 5: 清理过期的 expired sessions

#### 5.1 筛选 expired 状态且超过 24 小时的 sessions

```bash
grep -l "^status: expired" workspace/temporary-sessions/*.yaml 2>/dev/null || echo "NO_EXPIRED"
```

对于每个 expired session，读取文件检查：
- 如果有 `response.respondedAt`，且距今超过 24 小时 → 可清理
- 如果 `response` 为 null（超时未响应），且 `expiresAt` 距今超过 24 小时 → 可清理
- 否则保留

#### 5.2 删除过期文件

```bash
rm workspace/temporary-sessions/{id}.yaml
```

## 错误恢复

### 群聊已创建但卡片未发送

如果 Step 3.2 成功但 Step 3.3 失败：
- session 仍为 `pending` 状态
- 下次执行时，会重新创建群聊（产生新群聊）
- **缓解方案**: 激活前先检查 session 文件中是否已有 chatId 字段（非 null），如有则跳过创建群聊，直接发送卡片

### 重复执行保护

- Schedule 设置了 `blocking: true`，确保不会并发执行
- Session 状态更新是幂等的（重复激活不会产生副作用）

## 状态管理

| 状态 | 转换条件 | 执行操作 |
|------|----------|----------|
| pending → active | Schedule 激活 | 创建群聊 + 发送卡片 |
| active → expired | 用户响应 | 由 action prompt 处理 |
| active → expired | 超时 | Schedule 解散群聊 + 标记过期 |
| expired → deleted | 清理 | 删除 session 文件 |

## 注意事项

1. **enabled: false**: 默认禁用，需要手动启用
2. **Agent 自主调用**: 群组操作和卡片发送由 Agent 调用 MCP 工具完成
3. **Bash 仅用于文件 I/O**: 读写 session 文件使用 Bash，群组操作使用 MCP 工具
4. **actionPrompts 包含 session ID**: 确保按钮点击后能路由到正确的 session 文件
5. **幂等设计**: 重复执行不会产生副作用
