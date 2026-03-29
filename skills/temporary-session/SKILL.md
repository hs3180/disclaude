---
name: temporary-session
description: Temporary session lifecycle management - create, query, list, and respond to temporary sessions. Use when user says keywords like "创建临时会话", "临时群组", "temporary session", "创建会话", "会话管理".
allowed-tools: [Read, Write, Glob, Grep, Bash]
---

# Temporary Session Skill

临时会话生命周期管理。创建临时会话文件，供 Schedule 自动激活（创建群组 + 发送卡片），用户响应后更新状态，超时后自动清理。

## When to Use This Skill

**Use this skill for:**
- Creating temporary sessions that need user feedback (e.g., PR review requests, approval workflows)
- Querying the status of a specific session
- Listing all sessions with optional status filter
- Handling user responses to session action prompts

**Keywords**: "创建临时会话", "临时群组", "temporary session", "创建会话", "会话管理"

## Session Lifecycle

```
pending ──→ active ──→ responded ──→ expired (auto-cleanup)
                │
                └──→ expired (timeout, auto-dissolve)
```

| 状态 | 含义 | 转换条件 |
|------|------|----------|
| `pending` | 已创建，等待 Schedule 激活 | Schedule 创建群组并发送卡片 |
| `active` | 群组已创建，等待用户响应 | 用户点击卡片按钮 |
| `responded` | 用户已响应 | - |
| `expired` | 已超时或已处理 | 自动清理 |

## Session File Format

Session 文件存储在 `workspace/schedules/.sessions/{sessionId}.json`：

```json
{
  "id": "pr-123",
  "status": "pending",
  "chatId": null,
  "createdAt": "2026-03-24T10:00:00Z",
  "activatedAt": null,
  "expiresAt": "2026-03-25T10:00:00Z",
  "createGroup": {
    "name": "PR #123 Review",
    "description": "Review discussion for PR #123",
    "memberIds": ["ou_user1"]
  },
  "message": {
    "title": "PR Review Request",
    "context": "PR #123 needs your review",
    "question": "Please review this PR and choose an action:",
    "options": [
      {"text": "Approve", "value": "approve", "type": "primary"},
      {"text": "Request Changes", "value": "changes", "type": "default"},
      {"text": "Skip", "value": "skip", "type": "default"}
    ]
  },
  "actionPrompts": {
    "approve": "[Session Response] Session {id}: user approved. Execute approval workflow.",
    "changes": "[Session Response] Session {id}: user requested changes.",
    "skip": "[Session Response] Session {id}: user skipped."
  },
  "response": null
}
```

## Operations

### 1. Create Session

创建一个新的临时会话文件：

```bash
# Session 存储目录
SESSIONS_DIR="workspace/schedules/.sessions"
mkdir -p "$SESSIONS_DIR"

# 创建 session 文件
cat > "$SESSIONS_DIR/{sessionId}.json" << 'SESSION_EOF'
{
  "id": "{sessionId}",
  "status": "pending",
  "chatId": null,
  "createdAt": "{ISO timestamp}",
  "activatedAt": null,
  "expiresAt": "{ISO timestamp, e.g. 24h from now}",
  "createGroup": {
    "name": "{group name}",
    "description": "{optional group description}",
    "memberIds": ["{member open IDs}"]
  },
  "message": {
    "title": "{card title}",
    "context": "{optional context above question}",
    "question": "{main question/content}",
    "options": [
      {"text": "{button text}", "value": "{action value}", "type": "primary|default|danger"}
    ]
  },
  "actionPrompts": {
    "{action value}": "[Session Response] Session {id}: {description of what user did}. Context: {additional context for agent}."
  },
  "response": null
}
SESSION_EOF

echo "Session {sessionId} created as pending"
```

**参数说明**：
- `id`: 唯一标识符，建议格式 `{type}-{identifier}`（如 `pr-123`、`approval-456`）
- `expiresAt`: 超时时间，ISO 格式。超时后 Schedule 会自动解散群组
- `createGroup.memberIds`: 群组成员 open ID 列表（平台决定 ID 格式）
- `message.options`: 卡片按钮选项，`type` 可选 `primary`/`default`/`danger`
- `actionPrompts`: 按钮点击后发送给 Agent 的 prompt，`{id}` 会被替换为 session ID

### 2. Query Session

查询单个 session 的状态：

```bash
SESSIONS_DIR="workspace/schedules/.sessions"
cat "$SESSIONS_DIR/{sessionId}.json" 2>/dev/null || echo "Session not found"
```

### 3. List Sessions

列出所有 session，可按状态过滤：

```bash
SESSIONS_DIR="workspace/schedules/.sessions"

# 列出所有 sessions
for f in "$SESSIONS_DIR"/*.json; do
  [ -f "$f" ] && cat "$f" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{d[\"status\"]:12s} {d[\"id\"]}')" 2>/dev/null
done

# 仅列出 pending sessions
for f in "$SESSIONS_DIR"/*.json; do
  [ -f "$f" ] && grep -q '"pending"' "$f" && echo "$f"
done

# 仅列出 active sessions
for f in "$SESSIONS_DIR"/*.json; do
  [ -f "$f" ] && grep -q '"active"' "$f" && echo "$f"
done
```

### 4. Update Session Status

更新 session 状态（通常由 Schedule 或响应处理完成）：

```bash
SESSIONS_DIR="workspace/schedules/.sessions"

# 使用 python3 更新状态
python3 -c "
import json, sys
path = '$SESSIONS_DIR/{sessionId}.json'
with open(path) as f:
    data = json.load(f)
data['status'] = '{new_status}'
if '{new_status}' == 'active':
    data['activatedAt'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
if '{new_status}' == 'responded':
    data['response'] = {response_data}
with open(path, 'w') as f:
    json.dump(data, f, indent=2)
print('Session updated to {new_status}')
"
```

### 5. Delete Session

删除 session 文件：

```bash
rm "$SESSIONS_DIR/{sessionId}.json"
```

## Response Handling

当用户在群组中点击卡片按钮时，会触发 action prompt。Action prompt 中包含 session ID，Agent 可以：

1. 从 action prompt 中提取 session ID（格式: `[Session Response] Session {id}: ...`）
2. 读取对应 session 文件
3. 根据 action value 执行相应逻辑
4. 更新 session 状态为 `responded`

## Context Variables

When invoked, you receive:
- **Chat ID**: Chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Schedule Integration

此 Skill 与 `temporary-sessions.md` Schedule 配合工作：
- **Skill**: 负责 session 文件的 CRUD 操作
- **Schedule**: 负责自动激活 pending sessions、过期检查和清理

## Error Handling

- 如果 session 文件目录不存在，自动创建
- 如果 session 文件格式错误，报告错误并跳过
- 如果 session 已存在且为 active 状态，不重复创建群组

## DO NOT

- 不要直接在 Skill 中调用 MCP 工具（群组操作由 Schedule 负责）
- 不要创建重复的 session ID
- 不要手动设置 `activatedAt`（由 Schedule 自动设置）
- 不要修改已响应（responded）的 session 状态
