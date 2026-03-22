---
name: "Temporary Sessions"
cron: "*/10 * * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Temporary Sessions Manager

管理临时会话，处理 pending 状态的会话创建群聊，检查 active 状态的会话超时。

## 配置

- **扫描间隔**: 每 10 秒
- **超时处理**: 自动将超时会话标记为 expired

## 执行步骤

### 1. 扫描 pending 会话

```bash
# 使用 Node.js 脚本扫描
node -e "
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const sessionsDir = path.join(process.env.WORKSPACE_DIR || process.cwd(), 'temporary-sessions');
if (!fs.existsSync(sessionsDir)) {
  console.log('[]');
  process.exit(0);
}

const pending = [];
const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.yaml'));

for (const file of files) {
  try {
    const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
    const session = yaml.load(content);
    if (session.status === 'pending') {
      pending.push({
        id: file.replace('.yaml', ''),
        createGroup: session.createGroup,
        message: session.message,
        options: session.options
      });
    }
  } catch (e) {}
}

console.log(JSON.stringify(pending, null, 2));
"
```

### 2. 为每个 pending 会话创建群聊 ⚡

对于每个 pending 会话，执行以下操作：

#### 2.1 创建群聊

使用 `mcp__channel-mcp__send_text` 发送消息到新群聊。

首先调用飞书 API 创建群聊：

```bash
# 创建群聊
curl -X POST "https://open.feishu.cn/open-apis/im/v1/chats" \
  -H "Authorization: Bearer $FEISHU_TENANT_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "{session.createGroup.name}",
    "user_id_list": {JSON.stringify(session.createGroup.members)}
  }'
```

**注意**：如果无法直接调用 API，可以通过以下方式：
- 使用现有的 `mcp__channel-mcp__send_text` 工具，它会自动处理群聊创建

#### 2.2 发送交互卡片

群聊创建后，使用 `mcp__channel-mcp__send_interactive` 发送操作选项卡片：

**卡片内容**：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "🔔 请选择操作", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "{session.message}"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"content": "选项1", "tag": "plain_text"}, "value": "{option.value}", "type": "primary"}
    ]}
  ]
}
```

**actionPrompts**：动态生成，每个选项对应一个 action。

#### 2.3 更新会话状态

更新 YAML 文件：
```yaml
status: active
chatId: "{创建的群聊ID}"
messageId: "{发送的消息ID}"
```

### 3. 检查 active 会话超时

```bash
node -e "
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const sessionsDir = path.join(process.env.WORKSPACE_DIR || process.cwd(), 'temporary-sessions');
if (!fs.existsSync(sessionsDir)) {
  console.log('[]');
  process.exit(0);
}

const expired = [];
const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.yaml'));
const now = new Date();

for (const file of files) {
  try {
    const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
    const session = yaml.load(content);
    if (session.status === 'active' && new Date(session.expiresAt) < now) {
      expired.push({ id: file.replace('.yaml', '') });
    }
  } catch (e) {}
}

console.log(JSON.stringify(expired, null, 2));
"
```

对于每个超时的会话，更新状态为 expired：

```yaml
status: expired
```

## 回调处理

当用户点击卡片按钮时，回调处理器会：

1. 根据 messageId 查找对应的会话
2. 记录用户响应：
   ```yaml
   response:
     selectedValue: "{用户选择的值}"
     responder: "{用户 open_id}"
     repliedAt: "{当前时间 ISO 格式}"
   ```
3. 更新状态为 expired

## 会话文件格式

### 创建时 (pending)

```yaml
status: pending
chatId: null
messageId: null
expiresAt: 2026-03-11T10:00:00Z

createGroup:
  name: "PR #123: Fix auth bug"
  members:
    - ou_developer

message: |
  # 🔔 PR 审核请求
  **PR #123**: Fix authentication bug

options:
  - value: merge
    text: "✓ 合并"
  - value: close
    text: "✗ 关闭"

context:
  prNumber: 123

response: null
```

### 激活后 (active)

```yaml
status: active
chatId: oc_new_group_xxx
messageId: om_xxx
```

### 用户响应后 (expired)

```yaml
status: expired
response:
  selectedValue: merge
  responder: ou_developer
  repliedAt: 2026-03-10T14:30:00Z
```

## 调用方使用方式

### 创建会话

```typescript
import { createSession } from '@disclaude/core';

// 创建会话
const session = createSession({
  id: 'pr-123',
  createGroup: {
    name: 'PR #123: Fix auth bug',
    members: ['ou_developer']
  },
  message: '## 🔔 PR 审核请求\n\n**PR #123**: Fix authentication bug',
  options: [
    { value: 'merge', text: '✓ 合并' },
    { value: 'close', text: '✗ 关闭' }
  ],
  context: { prNumber: 123 },
  timeoutMinutes: 60
});
```

### 检查响应

```typescript
import { readSession } from '@disclaude/core';

// 定期检查
const session = readSession('pr-123');
if (session?.status === 'expired') {
  if (session.response) {
    // 用户已响应
    console.log('用户选择:', session.response.selectedValue);
    handleUserChoice(session.response.selectedValue);
  } else {
    // 超时未响应
    console.log('会话超时');
    handleTimeout();
  }
}
```

## 依赖

- Node.js + js-yaml
- 飞书 API (创建群聊)
- MCP Tool: mcp__channel-mcp__send_interactive

## 关联 Issue

- Issue #1391 - 临时会话管理系统（简化版设计）
- Issue #393 - PR Scanner
- Issue #631 - 离线提问
- Issue #946 - 御书房体验
