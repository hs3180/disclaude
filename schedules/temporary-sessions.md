---
name: "Temporary Session Manager"
cron: "0 */5 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Temporary Session Lifecycle Manager

定期管理临时会话的生命周期：激活 pending 会话、检查过期会话、解散过期群组、清理过期文件。

## 配置

- **会话目录**: `workspace/sessions/`
- **检查间隔**: 每 5 分钟
- **默认过期时间**: 24 小时（创建后）

## 执行步骤

### 1. 检查会话目录

```bash
ls workspace/sessions/ 2>/dev/null || echo "NO_SESSIONS_DIR"
```

如果返回 `NO_SESSIONS_DIR` 或目录为空，**退出本次执行**。

### 2. 列出所有 pending 会话

```bash
cat workspace/sessions/*.json 2>/dev/null | node -e "
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const input = Buffer.concat(chunks).toString();
    // Handle multiple JSON objects (not array)
    const lines = input.split('\n').filter(l => l.trim());
    const sessions = lines.map(l => JSON.parse(l)).filter(s => s.status === 'pending');
    sessions.forEach(s => console.log(s.id));
  } catch(e) { console.log('PARSE_ERROR'); }
});
"
```

如果没有 pending 会话，跳到步骤 4。

### 3. 激活 pending 会话

对每个 pending 会话：

#### 3.1 读取会话文件

```bash
cat workspace/sessions/{id}.json
```

#### 3.2 调用 MCP 工具创建群聊

使用 `create_chat` MCP 工具创建群聊：

```json
{
  "name": "{session.createGroup.name}",
  "description": "{session.createGroup.description}",
  "memberIds": "{session.createGroup.memberIds}"
}
```

记录返回的 `chatId`。

**如果创建失败**：
- 记录错误日志
- 跳过此会话，继续处理下一个
- 不修改会话状态（下次重试）

#### 3.3 调用 MCP 工具发送交互卡片

使用 `send_interactive` MCP 工具向新创建的群聊发送消息卡片：

**卡片内容**（format: "card"）：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "🔔 {session.createGroup.name}", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "{session.message}"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {按钮根据 session.options 动态生成}
    ]}
  ]
}
```

**actionPrompts**：每个按钮对应一个 action prompt，格式为：
```
[用户操作] 用户在临时会话 {session.id} 中选择了「{option.text}」。请读取 workspace/sessions/{session.id}.json，将 response 更新为 {"value": "{option.value}", "text": "{option.text}"}，status 更新为 "responded"，responseAt 更新为当前时间，然后根据 context 中的信息执行相应操作。
```

#### 3.4 更新会话文件

创建群聊和发送卡片成功后，使用 Bash 更新会话文件：

```bash
node -e "
const fs = require('fs');
const path = 'workspace/sessions/{id}.json';
const session = JSON.parse(fs.readFileSync(path, 'utf8'));
session.status = 'active';
session.chatId = '{returned-chatId}';
session.activatedAt = new Date().toISOString();
fs.writeFileSync(path, JSON.stringify(session, null, 2));
"
```

### 4. 检查并处理过期会话

#### 4.1 列出所有 active 会话

```bash
cat workspace/sessions/*.json 2>/dev/null | node -e "
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  try {
    const input = Buffer.concat(chunks).toString();
    const lines = input.split('\n').filter(l => l.trim());
    const now = new Date();
    const sessions = lines.map(l => JSON.parse(l)).filter(s => {
      if (s.status !== 'active') return false;
      const expiresAt = new Date(s.expiresAt);
      return expiresAt <= now;
    });
    sessions.forEach(s => console.log(s.id + '|' + s.chatId));
  } catch(e) { console.log('PARSE_ERROR'); }
});
"
```

如果没有过期会话，跳到步骤 5。

#### 4.2 解散过期群聊

对每个过期会话，调用 `dissolve_chat` MCP 工具：

```json
{
  "chatId": "{session.chatId}"
}
```

#### 4.3 更新会话状态

```bash
node -e "
const fs = require('fs');
const path = 'workspace/sessions/{id}.json';
const session = JSON.parse(fs.readFileSync(path, 'utf8'));
session.status = 'expired';
fs.writeFileSync(path, JSON.stringify(session, null, 2));
"
```

### 5. 清理过期会话文件

```bash
# 清理已过期超过 1 小时的会话文件（保留 responded 和 expired 状态）
find workspace/sessions/ -name '*.json' -mmin +60 -exec node -e "
const fs = require('fs');
const path = process.argv[1];
try {
  const session = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (session.status === 'expired' || session.status === 'responded') {
    fs.unlinkSync(path);
    console.log('CLEANED: ' + path);
  }
} catch(e) {}
" {} \;
```

## 状态管理

### 状态转换

```
pending ──[Schedule 激活]──> active ──[用户响应]──> responded ──[1h后清理]──> [删除]
    │                            │
    └──[超过 expiresAt]──────────┘──> expired ──[1h后清理]──> [删除]
```

### 状态说明

| 状态 | 含义 | 触发条件 |
|------|------|----------|
| `pending` | 等待激活 | Skill 创建会话文件 |
| `active` | 群聊已创建，等待用户响应 | Schedule 创建群聊并发送卡片 |
| `responded` | 用户已响应 | 用户点击卡片按钮 |
| `expired` | 已过期，群聊已解散 | 超过 expiresAt 时间 |

## 错误处理

- **MCP 工具调用失败**: 记录错误，跳过当前会话，不修改状态（下次重试）
- **会话文件损坏**: 跳过损坏的文件，记录错误
- **群聊已不存在**: 视为已解散，直接标记为 expired
- **会话目录不存在**: 创建目录后退出（无会话需要处理）

## 依赖

- MCP 工具: `create_chat` — 创建群聊
- MCP 工具: `dissolve_chat` — 解散群聊
- MCP 工具: `send_interactive` — 发送交互卡片
- Skill: `temporary-session` — 创建会话文件
- Node.js: 用于 JSON 文件读写操作

## 注意事项

1. **串行处理**: 每次执行只处理一个 pending 会话，避免并发问题
2. **幂等设计**: 多次执行不会产生副作用（创建群聊前检查状态）
3. **MCP 工具优先**: 群组操作和卡片发送必须通过 MCP 工具，不使用 Shell 脚本
4. **文件 I/O 仅限 Bash**: JSON 文件的读写使用 Node.js 在 Bash 中执行
5. **优雅降级**: 如果 MCP 工具不可用，记录错误但不中断其他会话的处理
