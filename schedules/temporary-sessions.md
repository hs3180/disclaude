---
name: "Temporary Session Manager"
cron: "*/5 * * * *"
enabled: false
blocking: true
chatId: "oc_your_schedule_chat_id"
createdAt: "2026-03-29T00:00:00.000Z"
---

# Temporary Session Lifecycle Manager

每 5 分钟检查并管理临时会话生命周期：自动激活 pending sessions、过期检查和清理。

## Session 存储目录

```
workspace/schedules/.sessions/
├── {sessionId}.json
└── ...
```

## 执行步骤

### Step 1: 列出 pending sessions

```bash
SESSIONS_DIR="workspace/schedules/.sessions"
mkdir -p "$SESSIONS_DIR"

# 列出所有 pending 状态的 sessions
for f in "$SESSIONS_DIR"/*.json; do
  [ -f "$f" ] && grep -q '"pending"' "$f" && echo "$f"
done
```

如果没有 pending sessions，跳到 Step 3。

### Step 2: 激活 pending sessions

对每个 pending session，执行以下操作：

#### 2.1 读取 session 文件

```bash
cat "$SESSIONS_DIR/{sessionId}.json"
```

#### 2.2 检查是否已超时

如果 `expiresAt` < 当前时间，直接标记为 expired 并跳过激活：

```bash
python3 -c "
import json, sys
from datetime import datetime, timezone
path = '$SESSIONS_DIR/{sessionId}.json'
with open(path) as f:
    data = json.load(f)
expires = datetime.fromisoformat(data['expiresAt'].replace('Z', '+00:00'))
now = datetime.now(timezone.utc)
if expires < now:
    data['status'] = 'expired'
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
    print('EXPIRED')
else:
    print('VALID')
"
```

#### 2.3 创建群组

调用 `create_chat` MCP 工具：

```
create_chat({
  "name": "{createGroup.name}",
  "description": "{createGroup.description}",
  "memberIds": {createGroup.memberIds}
})
```

如果创建失败，记录错误并跳过该 session，下次再重试。

#### 2.4 注册临时群组生命周期

调用 `register_temp_chat` MCP 工具，让 Primary Node 自动管理群组过期：

```
register_temp_chat({
  "chatId": "{返回的 chatId}",
  "expiresAt": "{session 的 expiresAt}",
  "context": { "sessionId": "{sessionId}" }
})
```

#### 2.5 发送交互卡片

调用 `send_interactive` MCP 工具：

```
send_interactive({
  "question": "{message.question}",
  "options": {message.options},
  "title": "{message.title}",
  "context": "{message.context}",
  "chatId": "{Step 2.3 返回的 chatId}",
  "actionPrompts": {
    "{每个 option 的 value}": "[Session Response] Session {sessionId}: user selected {{actionValue}}. Execute the corresponding action for session {sessionId}."
  }
})
```

**actionPrompts 说明**：
- 每个 option 的 value 作为 key
- value 中包含 session ID，确保响应可路由到正确的 session
- 使用 session 文件中预定义的 actionPrompts 模板

#### 2.6 更新 session 状态为 active

```bash
python3 -c "
import json
from datetime import datetime, timezone
path = '$SESSIONS_DIR/{sessionId}.json'
with open(path) as f:
    data = json.load(f)
data['status'] = 'active'
data['chatId'] = '{Step 2.3 返回的 chatId}'
data['activatedAt'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
print('Session activated')
"
```

### Step 3: 检查过期的 active sessions

```bash
SESSIONS_DIR="workspace/schedules/.sessions"

# 找出所有 active 但已超时的 sessions
for f in "$SESSIONS_DIR"/*.json; do
  [ -f "$f" ] || continue
  python3 -c "
import json, sys
from datetime import datetime, timezone
with open('$f') as fp:
    data = json.load(fp)
if data.get('status') == 'active':
    expires = datetime.fromisoformat(data['expiresAt'].replace('Z', '+00:00'))
    now = datetime.now(timezone.utc)
    if expires < now:
        print(f'{data[\"id\"]}|{data.get(\"chatId\", \"\")}')
" 2>/dev/null
done
```

对于每个过期 session，Primary Node 的 TempChatLifecycleService 会自动调用 `dissolve_chat` 解散群组。Schedule 只需要标记 session 状态：

```bash
python3 -c "
import json
path = '$SESSIONS_DIR/{sessionId}.json'
with open(path) as f:
    data = json.load(f)
data['status'] = 'expired'
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
print('Session expired')
"
```

### Step 4: 清理过期的 expired sessions

删除超过 24 小时的 expired session 文件：

```bash
SESSIONS_DIR="workspace/schedules/.sessions"
CUTOFF=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)

for f in "$SESSIONS_DIR"/*.json; do
  [ -f "$f" ] || continue
  python3 -c "
import json, sys
from datetime import datetime, timezone
with open('$f') as fp:
    data = json.load(fp)
if data.get('status') == 'expired':
    expires = datetime.fromisoformat(data['expiresAt'].replace('Z', '+00:00'))
    cutoff = datetime.fromisoformat('$CUTOFF'.replace('Z', '+00:00'))
    if expires < cutoff:
        import os
        os.remove('$f')
        print(f'Cleaned up expired session: {data[\"id\"]}')
" 2>/dev/null
done
```

## 错误处理

- **create_chat 失败**: 跳过该 session，下次执行时重试
- **send_interactive 失败**: 群组已创建但卡片未发送，标记为 active 让下次重试发送
- **register_temp_chat 失败**: 不阻塞流程，Primary Node 的 TempChatLifecycleService 会自动处理
- **Session 文件损坏**: 跳过该文件，记录警告
- **并发安全**: 每个操作前检查 session 当前状态，避免重复激活

## 注意事项

1. **MCP 工具调用**: 群组操作（create_chat）和卡片发送（send_interactive）由 Agent 自主调用 MCP 工具
2. **Bash 仅用于文件 I/O**: 读写 session 文件、状态更新、清理操作
3. **无状态设计**: Schedule 每次执行都从文件系统读取最新状态
4. **幂等性**: 重复执行不会产生副作用（先检查状态再操作）
5. **actionPrompts 路由**: 每个 action prompt 包含 session ID，确保用户响应可路由到正确的 session

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的 Schedule 执行 chatId
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整检查间隔（默认 5 分钟）

## 依赖

- MCP Tools: `create_chat`, `register_temp_chat`, `send_interactive`
- Primary Node: TempChatLifecycleService（自动解散过期群组）
- Python 3: 用于 JSON 文件操作
