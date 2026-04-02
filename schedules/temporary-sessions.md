---
name: "临时会话管理"
cron: "*/5 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-04-02T00:00:00.000Z"
---

# 临时会话生命周期管理

每 5 分钟扫描 `workspace/sessions/`，管理临时会话的完整生命周期：
- 激活 pending 状态的会话（创建群组 + 发送交互卡片）
- 过期超时的 active 会话（解散群组）
- 清理过期的 expired 会话文件

## 执行步骤

### 1. 检查 sessions 目录

```bash
ls workspace/sessions/*.json 2>/dev/null || echo "NO_SESSIONS"
```

如果输出 `NO_SESSIONS` 或目录为空，**退出本次执行**。

### 2. 读取所有 session 文件

使用 `Glob` 工具获取 `workspace/sessions/*.json`，然后逐个使用 `Read` 工具读取。

对每个 session 文件，解析 JSON 并按状态分类：
- **pending**: 等待激活
- **active**: 已激活，等待过期
- **expired**: 已过期，等待清理

### 3. 激活 pending 会话

对每个 `status: "pending"` 的 session：

#### 3.1 创建群组

调用 `create_chat` MCP 工具：

```json
{
  "name": "{session.createGroup.name}",
  "description": "{session.createGroup.description}",
  "memberIds": "{session.createGroup.memberIds}"
}
```

如果创建失败（返回 `❌`），**跳过该 session**，下次执行时重试。

#### 3.2 注册临时群组

调用 `register_temp_chat` MCP 工具，让 Primary Node 自动跟踪过期：

```json
{
  "chatId": "{上一步返回的 chatId}",
  "expiresAt": "{session.expiresAt}",
  "context": {"sessionId": "{session.id}"}
}
```

#### 3.3 发送交互卡片

调用 `send_interactive` MCP 工具到新建群组：

```json
{
  "question": "{session.message.question}",
  "options": "{session.message.options}",
  "title": "{session.message.title}",
  "context": "{session.message.context}",
  "chatId": "{上一步返回的 chatId}",
  "actionPrompts": "{session.actionPrompts}"
}
```

#### 3.4 更新 session 文件

使用 `Edit` 或 `Write` 工具更新 session 文件：
- `status` → `"active"`
- `chatId` → 创建的群组 chatId
- `activatedAt` → 当前 ISO 8601 时间戳

### 4. 过期 active 会话

对每个 `status: "active"` 的 session，检查是否超时：

**判断条件**: `session.expiresAt` < 当前时间

对每个超时的 session：

#### 4.1 解散群组

如果 `session.chatId` 不为空，调用 `dissolve_chat` MCP 工具：

```json
{
  "chatId": "{session.chatId}"
}
```

#### 4.2 更新 session 文件

使用 `Edit` 或 `Write` 工具更新 session 文件：
- `status` → `"expired"`

### 5. 清理 expired 会话文件

对每个 `status: "expired"` 的 session，检查是否超过保留期：

**保留期**: `expiredAt` + 1 小时（或 session 中无 `expiredAt` 字段时，直接清理）

使用 `Bash` 工具删除超过保留期的 session 文件：

```bash
rm workspace/sessions/{sessionId}.json
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| sessions 目录不存在 | 创建目录后退出（`mkdir -p workspace/sessions`） |
| session JSON 解析失败 | 记录警告，跳过该文件 |
| `create_chat` 失败 | 跳过该 session，保持 pending 状态等待下次重试 |
| `send_interactive` 失败 | 群组已创建但卡片发送失败，标记为 active 并发送失败通知 |
| `dissolve_chat` 失败 | 记录错误，仍将 session 标记为 expired |
| session 文件更新失败 | 记录错误，不影响其他 session 处理 |

## 状态管理

### 状态转换

```
pending ──[create_chat + send_interactive]──→ active ──[expiresAt reached]──→ expired ──[+1h cleanup]──→ (deleted)
   ↑                                            │
   └──────────────[retry on next run]────────────┘ (if activation failed)
```

### 文件状态示例

**pending** (刚创建):
```json
{
  "id": "pr-123",
  "status": "pending",
  "chatId": null,
  "createdAt": "2026-04-02T10:00:00Z",
  "expiresAt": "2026-04-03T10:00:00Z",
  ...
}
```

**active** (已激活):
```json
{
  "id": "pr-123",
  "status": "active",
  "chatId": "oc_abc123",
  "activatedAt": "2026-04-02T10:05:00Z",
  ...
}
```

**expired** (已过期):
```json
{
  "id": "pr-123",
  "status": "expired",
  "chatId": "oc_abc123",
  "activatedAt": "2026-04-02T10:05:00Z",
  ...
}
```

## 重要提示

1. **不要创建新的定时任务** — 这是定时任务执行环境的规则
2. **不要修改现有的定时任务**
3. **串行处理** — 逐个处理 session，避免并发问题
4. **幂等设计** — 重复执行不会产生副作用（创建群组前检查 status）
5. **只处理 workspace/sessions/ 下的文件**
6. **完成后结束，不要执行无关操作**
