---
name: "临时会话管理"
cron: "*/5 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-03-10T00:00:00.000Z"
---

# 临时会话管理

基于文件系统的临时会话管理模块，统一管理 PR 讨论、离线提问、御书房审核等场景。

## 设计原则

| 维度 | 方案 |
|------|------|
| 组织方式 | 每个会话一个文件夹 |
| 配置文件 | `session.md`（静态配置） |
| 状态文件 | `state.yaml`（动态状态） |
| 回调机制 | **不实现** - 调用方主动轮询 |

## 文件夹结构

```
workspace/temporary-sessions/
├── {session-id}/
│   ├── session.md    # 配置（静态）：参数、目的、选项
│   └── state.yaml    # 状态（动态）：状态、响应
│
├── pr-123-review/
├── offline-config-789/
└── examples/
    └── template/
        ├── session.md
        └── state.yaml
```

## 执行步骤

### 1. 扫描 pending 状态的会话

```bash
# 查找所有 state.yaml 中 status 为 pending 的会话
find workspace/temporary-sessions -name "state.yaml" -exec grep -l "status: pending" {} \;
```

### 2. 处理 pending 会话

对于每个 pending 会话：

#### 2.1 读取会话配置

```bash
cat workspace/temporary-sessions/{session-id}/session.md
```

#### 2.2 创建通道并发送消息

根据 `channel.type` 决定创建方式：

| channel.type | 操作 |
|--------------|------|
| `group` | 创建新群聊，邀请成员 |
| `private` | 创建私聊 |
| `existing` | 使用现有 chatId |

使用 `send_message` 发送会话内容：

```
send_message({
  chatId: "{创建或现有的chatId}",
  parentMessageId: null,
  content: "{session.md 内容格式化后}",
  format: "card" | "text"
})
```

#### 2.3 更新状态为 sent

```yaml
# 更新 state.yaml
status: sent
chatId: "{创建的chatId}"
messageId: "{消息ID}"
sentAt: "{当前时间ISO}"
expiresAt: "{createdAt + expiresIn}"
```

### 3. 检查已过期会话

```bash
# 查找所有 sent 状态且已过期的会话
find workspace/temporary-sessions -name "state.yaml" -exec grep -l "status: sent" {} \;
```

对于每个已过期的会话，更新状态：

```yaml
status: expired
expiredAt: "{当前时间ISO}"
```

### 4. 处理用户响应（通过轮询）

用户点击按钮后，外部系统会更新 `state.yaml`：

```yaml
status: replied
repliedAt: "{响应时间ISO}"
response: "{用户选择的选项}"
```

**注意**：管理模块**只负责状态转换**，不执行任何回调或业务逻辑。

## 状态机

```
pending → sent → replied → 调用方轮询处理
              ↘ expired → 调用方轮询处理
```

| 状态 | 触发 | 处理动作 |
|------|------|----------|
| `pending` | 文件夹创建 | 等待下次扫描 |
| `sent` | pending 检测到 | 创建通道 + 发送消息 + 更新状态 |
| `replied` | 用户点击按钮 | 外部更新 state.yaml |
| `expired` | 超时 | 更新 state.yaml |

## 会话配置格式

### session.md 模板

```markdown
---
type: blocking           # blocking | non-blocking
purpose: pr-review       # pr-review | offline-question | agent-confirm
channel:
  type: group            # group | private | existing
  name: "PR #123"        # 群名（type=group 时）
  chatId: null           # 现有chatId（type=existing 时）
  members: [ou_xxx]      # 成员列表
context:
  prNumber: 123
  repository: owner/repo
expiresIn: 24h
---

# 🔔 PR 审核请求

消息内容...

## 选项
- [merge] ✓ 合并
- [close] ✗ 关闭
- [wait] ⏳ 等待
```

### state.yaml 模板

```yaml
status: pending          # pending | sent | replied | expired
chatId: null
messageId: null
createdAt: 2026-03-10T10:00:00Z
sentAt: null
expiresAt: null
repliedAt: null
response: null           # 用户响应后填充
```

## 三个 Use Case

### PR Scanner (#393)
- `type: blocking`
- `channel.type: group` (创建新群)
- PR Scanner schedule 轮询检查 `status: replied`，执行 `gh pr` 命令

### 离线提问 (#631)
- `type: non-blocking`
- `channel.type: existing` (复用通道)
- Agent 恢复时检查状态，继续执行

### 御书房 (#946)
- `type: blocking`
- `channel.type: existing` (复用通道)
- ask_user 同步轮询等待响应，或返回 sessionId

## 错误处理

1. 如果读取 session.md 失败，记录错误日志，跳过该会话
2. 如果创建群聊失败，更新 state.yaml 记录错误信息
3. 如果发送消息失败，保留 pending 状态，下次重试

## 配置说明

- **cron**: 每 5 分钟扫描一次
- **enabled**: 默认启用
- **chatId**: 默认聊天 ID（用于错误通知）

## 依赖

- `send_message` MCP Tool
- `workspace/temporary-sessions/` 目录
- 会话调用方负责轮询和处理响应
