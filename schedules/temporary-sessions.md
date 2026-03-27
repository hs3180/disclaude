---
name: "Temporary Sessions Manager"
cron: "0 */5 * * * *"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Temporary Sessions Manager

定期管理临时会话的生命周期：激活 pending 会话、过期超时 active 会话、清理 expired 会话。

## 配置

- **检查间隔**: 每 5 分钟
- **默认超时**: 24 小时（从激活时间算起）
- **清理延迟**: 过期后保留 1 小时再清理文件

## 执行步骤

### Step 1: 列出 pending 会话

```bash
ls temporary-sessions/*.json 2>/dev/null | while read f; do
  status=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$f','utf8')).status)")
  [ "$status" = "pending" ] && echo "$f"
done
```

如果结果为空，跳到 Step 3。

### Step 2: 激活 pending 会话

对每个 pending 会话文件：

#### 2.1 读取会话信息

```bash
cat temporary-sessions/{id}.json
```

提取以下字段：
- `id`: 会话 ID
- `createGroup.name`: 群组名称
- `createGroup.memberIds`: 成员 ID 列表
- `message.title`: 卡片标题
- `message.context`: 上下文信息
- `message.question`: 问题描述
- `message.options`: 选项列表
- `message.actionPrompts`: 操作提示映射

#### 2.2 创建群聊

调用 `create_chat` MCP 工具：

```
create_chat({
  name: "{createGroup.name}",
  memberIds: {createGroup.memberIds}
})
```

记录返回的 `chatId`。

**错误处理**：如果创建群聊失败，跳过该会话并记录错误，下次执行时重试。

#### 2.3 发送交互卡片

调用 `send_interactive` MCP 工具：

```
send_interactive({
  title: "{message.title}",
  context: "{message.context}",
  question: "{message.question}",
  options: {message.options},
  actionPrompts: {message.actionPrompts},
  chatId: "{chatId from Step 2.2}"
})
```

**错误处理**：如果发送卡片失败，仍然将会话标记为 active（群聊已创建），但记录警告。

#### 2.4 更新会话状态

```bash
node -e "
const fs = require('fs');
const path = 'temporary-sessions/{id}.json';
const session = JSON.parse(fs.readFileSync(path, 'utf8'));
session.status = 'active';
session.chatId = '{chatId from Step 2.2}';
session.activatedAt = new Date().toISOString();
fs.writeFileSync(path, JSON.stringify(session, null, 2));
"
```

### Step 3: 检查并过期超时的 active 会话

```bash
ls temporary-sessions/*.json 2>/dev/null | while read f; do
  node -e "
    const session = JSON.parse(require('fs').readFileSync('$f', 'utf8'));
    if (session.status !== 'active') return;
    const activatedAt = new Date(session.activatedAt).getTime();
    const now = Date.now();
    const timeoutMs = 24 * 60 * 60 * 1000; // 24 hours
    if (now - activatedAt > timeoutMs) {
      console.log('$f');
    }
  "
done
```

如果结果为空，跳到 Step 5。

### Step 4: 处理超时会话

对每个超时的 active 会话：

#### 4.1 解散群聊

调用 `dissolve_chat` MCP 工具：

```
dissolve_chat({
  chatId: "{session.chatId}"
})
```

**错误处理**：如果解散失败（如群组已被手动删除），仍然更新会话状态。

#### 4.2 更新会话状态

```bash
node -e "
const fs = require('fs');
const path = 'temporary-sessions/{id}.json';
const session = JSON.parse(fs.readFileSync(path, 'utf8'));
session.status = 'expired';
session.response = {
  selectedValue: 'timeout',
  responder: null,
  repliedAt: new Date().toISOString()
};
fs.writeFileSync(path, JSON.stringify(session, null, 2));
"
```

### Step 5: 清理过期的 expired 会话

清理超过 1 小时的 expired 会话文件：

```bash
ls temporary-sessions/*.json 2>/dev/null | while read f; do
  node -e "
    const session = JSON.parse(require('fs').readFileSync('$f', 'utf8'));
    if (session.status !== 'expired') return;
    const responseTime = session.response?.repliedAt
      ? new Date(session.response.repliedAt).getTime()
      : Date.now();
    const now = Date.now();
    const cleanupMs = 60 * 60 * 1000; // 1 hour
    if (now - responseTime > cleanupMs) {
      console.log('$f');
    }
  "
done
```

对需要清理的文件执行删除：

```bash
rm temporary-sessions/{id}.json
```

## 错误处理

- **会话文件损坏**: 跳过该文件，记录错误，不中断其他会话处理
- **群聊创建失败**: 跳过该会话，保持 pending 状态，下次重试
- **卡片发送失败**: 仍然标记为 active，记录警告
- **群聊解散失败**: 仍然标记为 expired（避免无限重试）
- **MCP 工具不可用**: 记录错误，跳过所有需要 MCP 的操作

## 日志格式

每次执行后在 chat 中报告摘要：

```
📋 Temporary Sessions Report ({timestamp})
- Activated: {n} sessions
- Expired (timeout): {n} sessions
- Cleaned up: {n} sessions
- Errors: {n}
```

## 注意事项

1. **幂等设计**: 每次执行都是安全的，可以重复运行
2. **串行处理**: 一次处理一个会话，避免并发问题
3. **超时默认值**: 24 小时，可在会话文件的 `expiresAt` 字段自定义
4. **MCP 工具**: 群组操作必须通过 MCP 工具完成，不使用平台 API
5. **默认禁用**: schedule 默认 `enabled: false`，需要手动启用

## 依赖

- MCP Tools: `create_chat`, `dissolve_chat`, `send_interactive`
- Directory: `temporary-sessions/`
