---
name: "Temporary Sessions Manager"
cron: "0 */5 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-03-24T00:00:00.000Z"
---

# Temporary Sessions - 生命周期管理

自动管理临时会话的完整生命周期：激活 pending 会话、过期超时会话、清理过期会话。

## 配置

- **会话目录**: `workspace/temporary-sessions/`
- **默认超时**: 24 小时（由各会话的 `expiresAt` 决定）
- **清理保留期**: 过期后保留 1 小时再删除文件
- **执行间隔**: 每 5 分钟

## 执行步骤

### Step 1: 检查会话目录

```bash
ls workspace/temporary-sessions/*.json 2>/dev/null
```

如果没有文件，退出本次执行。

### Step 2: 列出 pending 状态的会话

```bash
cat workspace/temporary-sessions/*.json | python3 -c "
import sys, json
sessions = [json.loads(line) for line in sys.stdin.read().replace('}{', '}\n{').split('\n') if line.strip()]
pending = [s for s in sessions if s.get('status') == 'pending']
for s in pending:
    print(json.dumps(s))
"
```

如果无 pending 会话，跳到 Step 4。

### Step 3: 激活 pending 会话

对每个 pending 会话，按以下顺序执行：

#### 3.1 创建群组

使用 `feishu_create_chat` MCP 工具创建群组：

```json
{
  "name": "{createGroup.name}",
  "members": "{createGroup.members}"
}
```

**如果创建失败**（如网络错误、权限不足）：
- 跳过此会话，不更新状态
- 记录错误信息

#### 3.2 发送交互式卡片到新群组

使用 `send_interactive` 工具发送卡片到新创建的群组：

**卡片内容**（format: "card"）：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "{createGroup.name}", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "{message}"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "{option.text}", "tag": "plain_text"}, "value": "session-{id}-{option.value}", "type": "primary"}
    ]}
  ],
  "chatId": "{new_chatId}"
}
```

**actionPrompts**（每个选项一个）：
```json
{
  "session-{id}-{option.value}": "[会话响应] 用户在临时会话 {id} 中选择了「{option.text}」(value: {option.value})。请执行：1. 读取 workspace/temporary-sessions/{id}.json 2. 更新 status 为 expired 3. 记录 response: {{selectedValue: \"{option.value}\", responder: \"{user_open_id}\", repliedAt: \"{timestamp}\"}} 4. 写回文件"
}
```

#### 3.3 更新会话状态为 active

```bash
python3 -c "
import json
with open('workspace/temporary-sessions/{id}.json', 'r') as f:
    session = json.load(f)
session['status'] = 'active'
session['chatId'] = '{new_chatId}'
session['activatedAt'] = '$(date -u +%Y-%m-%dT%H:%M:%SZ)'
with open('workspace/temporary-sessions/{id}.json', 'w') as f:
    json.dump(session, f, indent=2)
print('Session {id} activated, chatId: {new_chatId}')
"
```

### Step 4: 检查并过期超时的 active 会话

```bash
cat workspace/temporary-sessions/*.json | python3 -c "
import sys, json
from datetime import datetime, timezone
sessions = [json.loads(line) for line in sys.stdin.read().replace('}{', '}\n{').split('\n') if line.strip()]
now = datetime.now(timezone.utc).isoformat()
expired = [s for s in sessions if s.get('status') == 'active' and s.get('expiresAt', '') < now]
for s in expired:
    print(json.dumps(s))
"
```

如果无超时会话，跳到 Step 6。

### Step 5: 解散超时会话的群组

对每个超时的 active 会话：

#### 5.1 解散群组

使用 `feishu_dissolve_chat` MCP 工具：

```json
{
  "chatId": "{session.chatId}"
}
```

**如果解散失败**：
- 仍然标记为 expired（群组可能已被手动解散）

#### 5.2 更新会话状态为 expired

```bash
python3 -c "
import json
with open('workspace/temporary-sessions/{id}.json', 'r') as f:
    session = json.load(f)
session['status'] = 'expired'
with open('workspace/temporary-sessions/{id}.json', 'w') as f:
    json.dump(session, f, indent=2)
print('Session {id} expired (timeout)')
"
```

### Step 6: 清理过期的 expired 会话文件

删除 `status` 为 `expired` 且 `response` 不为 null（已有用户响应）或已过期超过 1 小时的会话文件：

```bash
python3 -c "
import os, json, glob
from datetime import datetime, timezone, timedelta

now = datetime.now(timezone.utc)
cutoff = now - timedelta(hours=1)

for filepath in glob.glob('workspace/temporary-sessions/*.json'):
    try:
        with open(filepath, 'r') as f:
            session = json.load(f)
        if session.get('status') != 'expired':
            continue
        # Clean up if user responded, or expired > 1 hour ago
        if session.get('response') is not None:
            os.remove(filepath)
            print(f'Cleaned up (responded): {session[\"id\"]}')
            continue
        # Check if expired long enough
        expires_at = session.get('expiresAt', '')
        if expires_at:
            try:
                exp_time = datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
                if now - exp_time > timedelta(hours=1):
                    os.remove(filepath)
                    print(f'Cleaned up (timeout > 1h): {session[\"id\"]}')
            except:
                pass
    except Exception as e:
        print(f'Error processing {filepath}: {e}')
"
```

## 错误处理

- **会话文件损坏**: 跳过并记录警告，不中断其他会话处理
- **MCP 工具不可用**: 跳过需要 MCP 工具的步骤，下次执行重试
- **群组创建失败**: 保持 `pending` 状态，下次执行重试
- **群组解散失败**: 仍然标记 `expired`，避免无限重试
- **文件写入失败**: 记录错误，不中断流程

## 状态管理

### 状态转换图

```
pending ──(群组创建+卡片发送)──> active ──(用户响应/超时)──> expired
   │                                                                     │
   └──(手动取消)──────────────────────────────────────────────────────────>┘
```

### 状态转换规则

| From | To | Trigger | Actor |
|------|-----|---------|-------|
| pending | active | 群组创建完成 + 卡片已发送 | Schedule (本文件) |
| active | expired | 用户点击卡片按钮 | Agent (响应 action prompt) |
| active | expired | 超过 `expiresAt` | Schedule (本文件) |
| pending | expired | 手动取消 | Agent (Skill 操作) |

## 注意事项

1. **MCP 工具调用**: 群组操作和卡片发送由 Agent 自主调用 MCP 工具，不写在 bash 代码块中
2. **Bash 仅用于文件 I/O**: 读写 session 文件、清理过期文件
3. **幂等性**: 重复执行不会创建重复群组（通过状态检查保证）
4. **无状态设计**: Schedule 不保存状态，所有状态在 session 文件中
5. **串行处理**: 一次处理一个会话，避免并发问题
6. **容错性**: 单个会话失败不影响其他会话处理

## 依赖

- MCP Tool: `feishu_create_chat` - 创建群组
- MCP Tool: `feishu_dissolve_chat` - 解散群组
- MCP Tool: `send_interactive` - 发送交互式卡片
- Python 3: 用于 JSON 文件处理
- 目录: `workspace/temporary-sessions/`

## 相关

- Parent Issue: #1391
- Skill: `skills/temporary-session/SKILL.md`
- MCP Tools: #1546 (PR #1550)
