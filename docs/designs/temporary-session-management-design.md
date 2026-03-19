# 临时会话管理 (Temporary Session Management) 设计文档

> 统一抽象 Issue #393, #631, #946 的共同需求
> Version: v0.5
> Status: Draft
> Created: 2026-03-10
> Updated: 2026-03-10

## 设计原则

**核心原则**:
1. 复用现有 schedules 系统作为会话管理模块
2. 每个会话使用**文件夹**组织，包含两个文件
3. **不实现回调机制** - 会话管理只负责消息传递和状态跟踪，响应处理由调用方负责

| 维度 | 方案 |
|------|------|
| 组织方式 | 每个会话一个文件夹 |
| 配置文件 | `session.md`（静态配置） |
| 状态文件 | `state.yaml`（动态状态） |
| 管理入口 | `schedules/temporary-sessions.md` |

## 文件夹结构

```
temporary-sessions/
├── {session-id}/                 # 每个会话一个文件夹
│   ├── session.md                # 配置（静态）：参数、目的、选项
│   └── state.yaml                # 状态（动态）：状态、响应
│
├── pr-123-review/
│   ├── session.md
│   └── state.yaml
│
├── offline-config-789/
│   ├── session.md
│   └── state.yaml
│
└── examples/                     # 示例文件
    ├── pr-review.example/
    ├── offline-question.example/
    └── agent-confirm.example/
```

## 文件职责

| 文件 | 何时创建 | 谁修改 | 内容 |
|------|----------|--------|------|
| `session.md` | 会话创建时 | 创建者（只写一次） | 类型、目的、通道、选项 |
| `state.yaml` | 首次处理时 | 管理模块（频繁更新） | 状态、chatId、messageId、响应 |

---

## 1. session.md 格式规范

### 1.1 Frontmatter 字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `type` | string | ✅ | `blocking` \| `non-blocking` |
| `purpose` | string | ✅ | `pr-review` \| `offline-question` \| `agent-confirm` |
| `channel.type` | string | ✅ | `group` \| `private` \| `existing` |
| `channel.name` | string | group 必需 | 群聊名称 |
| `channel.members` | string[] | group 可选 | 群成员 open_id |
| `channel.existingChatId` | string | existing 必需 | 现有 chatId |
| `context` | object | ✅ | 上下文元数据（供调用方使用） |
| `expiresIn` | duration | 可选 | 过期时间（如 `24h`、`5m`） |

### 1.2 Body 结构

1. **消息内容** - 发送给用户的文本
2. **选项定义** - 使用 `[value] text` 格式

### 1.3 完整示例

```markdown
---
type: blocking
purpose: pr-review
channel:
  type: group
  name: "PR #123: Fix authentication bug"
  members:
    - ou_developer
    - ou_reviewer1
context:
  prNumber: 123
  repository: hs3180/disclaude
  author: developer
expiresIn: 24h
---

# 🔔 PR 审核请求

发现新的 Pull Request:

**PR #123**: Fix authentication bug

作者: @developer

请选择处理方式:

## 选项

- [merge] ✓ 合并
- [close] ✗ 关闭
- [wait] ⏳ 等待
```

---

## 2. state.yaml 格式规范

### 2.1 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | string | `pending` → `sent` → `replied` / `expired` |
| `chatId` | string | 实际通道 ID |
| `messageId` | string | 发送的消息 ID |
| `createdAt` | datetime | 创建时间 (ISO 8601) |
| `sentAt` | datetime | 发送时间 |
| `expiresAt` | datetime | 过期时间 |
| `repliedAt` | datetime | 响应时间 |
| `response` | object | 用户响应数据 |

### 2.2 初始状态（管理模块创建）

```yaml
status: pending
chatId: null
messageId: null
createdAt: 2026-03-10T10:00:00Z
sentAt: null
expiresAt: null
response: null
```

### 2.3 已发送状态

```yaml
status: sent
chatId: oc_xxx
messageId: om_xxx
createdAt: 2026-03-10T10:00:00Z
sentAt: 2026-03-10T10:00:05Z
expiresAt: 2026-03-11T10:00:00Z
response: null
```

### 2.4 用户响应后

```yaml
status: replied
chatId: oc_xxx
messageId: om_xxx
createdAt: 2026-03-10T10:00:00Z
sentAt: 2026-03-10T10:00:05Z
expiresAt: 2026-03-11T10:00:00Z
repliedAt: 2026-03-10T14:30:00Z
response:
  selectedValue: merge
  responder: ou_developer
```

### 2.5 超时状态

```yaml
status: expired
# ... 其他字段保持不变
```

---

## 3. 状态机

```
                    ┌─────────────┐
                    │   pending   │  session.md 创建
                    └──────┬──────┘
                           │
              管理模块检测到 pending
                           │
                           ▼
                    ┌─────────────┐
                    │    sent     │  消息发送完成
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
       ┌──────────┐              ┌──────────┐
       │ replied  │              │ expired  │
       └──────────┘              └──────────┘
              │                         │
              │                         │
              ▼                         ▼
        调用方轮询                  调用方轮询
        读取 response              处理超时
```

| 状态 | 触发 | 处理动作 |
|------|------|----------|
| `pending` | 文件夹创建 | 管理模块创建 state.yaml |
| `sent` | pending 检测到 | 创建通道 + 发送消息 |
| `replied` | 用户点击按钮 | 更新 state.yaml（不做其他操作） |
| `expired` | 超时 | 更新 state.yaml（不做其他操作） |

**关键设计**: 管理模块**只负责状态转换**，不执行任何回调。

---

## 4. 管理模块 (schedule)

### 4.1 schedules/temporary-sessions.md

```markdown
---
name: "Temporary Sessions Manager"
cron: "*/5 * * * * *"
enabled: true
blocking: false
---

# 临时会话管理器

扫描 `temporary-sessions/` 目录，管理会话生命周期。

## 执行步骤

1. 扫描所有会话文件夹
2. 对于每个会话：
   - 无 state.yaml → 创建 state.yaml (status: pending)
   - status: pending → 创建通道 + 发送消息 → status: sent
   - status: sent → 检查过期 → status: expired（如超时）
3. **不执行任何回调** - 只更新状态
```

### 4.2 用户响应处理（Feishu 回调）

当用户点击按钮时，Feishu 回调处理器只需更新 state.yaml：

```typescript
// 回调处理器 - 只更新状态，不执行回调
async function handleCardAction(event) {
  const { message_id, action_value, operator } = event;

  // 1. 根据 messageId 找到会话目录
  const sessionDir = await findSessionByMessageId(message_id);
  if (!sessionDir) return;

  // 2. 更新 state.yaml
  const state = readYAML(join(sessionDir, 'state.yaml'));
  state.status = 'replied';
  state.repliedAt = new Date().toISOString();
  state.response = {
    selectedValue: action_value,
    responder: operator.open_id,
  };
  writeYAML(join(sessionDir, 'state.yaml'), state);

  // 3. 完成 - 调用方自行轮询处理
}
```

---

## 5. 调用方如何处理响应

由于没有回调机制，调用方需要**主动轮询**会话状态。

### 5.1 PR Scanner (#393)

PR Scanner 在自己的 schedule 中检查会话状态：

```markdown
<!-- schedules/pr-scanner.md -->
---
name: "PR Scanner"
cron: "0 */15 * * * *"
---

## 步骤

1. 扫描新 PR
2. 为新 PR 创建 `temporary-sessions/pr-{number}/`
3. **检查已有会话**:
   - 读取 `temporary-sessions/pr-*/state.yaml`
   - 如果 `status: replied`，根据 `response.selectedValue` 执行操作
   - 如果 `status: expired`，添加 stale 标签
```

### 5.2 离线提问 (#631)

Agent 在恢复时检查响应：

```typescript
// Agent 恢复执行时
async function resumeTask(taskId: string) {
  const statePath = `temporary-sessions/offline-${taskId}/state.yaml`;
  const state = readYAML(statePath);

  if (state.status === 'replied') {
    // 用户已响应，继续执行
    return state.response.selectedValue;
  } else if (state.status === 'expired') {
    // 超时，使用默认值
    return 'default';
  }

  // 仍未响应，继续等待
  return null;
}
```

### 5.3 御书房 (#946)

ask_user 需要重新设计为**同步等待**或**轮询**模式：

```typescript
// 方案 A: 同步等待（阻塞 Agent）
async function ask_user(params: AskUserParams): Promise<AskUserResult> {
  // 1. 创建会话
  const sessionId = createSession(params);

  // 2. 轮询等待响应
  while (true) {
    const state = readState(sessionId);
    if (state.status === 'replied') {
      return { success: true, response: state.response };
    }
    if (state.status === 'expired') {
      return { success: false, error: 'timeout' };
    }
    await sleep(1000); // 每秒检查一次
  }
}

// 方案 B: 非阻塞（返回 sessionId，调用方轮询）
async function ask_user(params: AskUserParams): Promise<AskUserResult> {
  const sessionId = createSession(params);
  return { success: true, sessionId, message: '等待用户响应' };
}
```

---

## 6. 三个 Use Case 示例

### 6.1 PR Scanner (#393)

**文件夹**: `pr-123-review/`

**session.md**:
```markdown
---
type: blocking
purpose: pr-review
channel:
  type: group
  name: "PR #123"
  members: [ou_author, ou_reviewer]
context:
  prNumber: 123
  repository: hs3180/disclaude
expiresIn: 24h
---

# 🔔 PR 审核请求

**PR #123**: Add OAuth2 support

作者: @developer

## 选项
- [merge] ✓ 合并
- [close] ✗ 关闭
- [wait] ⏳ 等待
```

**处理方式**: PR Scanner schedule 定期检查 `status: replied`，然后执行相应的 `gh pr` 命令。

### 6.2 离线提问 (#631)

**文件夹**: `offline-deploy-abc/`

**session.md**:
```markdown
---
type: non-blocking
purpose: offline-question
channel:
  type: existing
  existingChatId: oc_user_private
context:
  taskId: deploy-abc
  agentId: pilot-main
  resumePoint: step-5
---

# 💭 离线提问

Agent 在执行部署任务时需要您的确认:

选择部署策略:
1. **蓝绿部署** - 零停机
2. **滚动更新** - 渐进式

## 选项
- [blue-green] 蓝绿部署
- [rolling] 滚动更新
- [cancel] 取消部署
```

**处理方式**: Agent 恢复时检查 `status: replied`，读取 `response.selectedValue` 继续执行。

### 6.3 御书房 (#946)

**文件夹**: `review-xyz789/`

**session.md**:
```markdown
---
type: blocking
purpose: agent-confirm
channel:
  type: existing
  existingChatId: oc_current_chat
context:
  taskId: review-xyz789
expiresIn: 5m
---

# 🤖 Agent 提问

在审查代码时发现问题:

**src/auth.ts:45** - 可能存在时序攻击风险

## 选项
- [fix] ✓ 应用修复
- [ignore] ✗ 忽略
- [discuss] 💬 讨论
```

**处理方式**: ask_user 同步轮询等待响应，或返回 sessionId 让调用方轮询。

---

## 7. 实现计划

| Phase | 内容 | 工作量 |
|-------|------|--------|
| 1 | 创建 `schedules/temporary-sessions.md` | 0.5 天 |
| 2 | 创建示例文件夹 | 0.5 天 |
| 3 | 集成 PR Scanner（轮询检查） | 0.5 天 |
| 4 | 重新设计 ask_user（同步等待或轮询） | 1 天 |

**总工作量**: 2.5 天

---

## 8. 与旧版本的区别

| 维度 | v0.4（有回调） | v0.5（无回调） |
|------|---------------|---------------|
| session.md | 包含 `callback` 代码块 | 只有消息和选项 |
| 管理模块 | 执行回调命令 | 只更新状态 |
| 复杂度 | 高（DSL 解析、命令执行） | 低（纯状态管理） |
| 故障点 | 回调执行失败 | 几乎没有 |
| 调用方 | 被动等待回调 | 主动轮询状态 |

---

## 9. 参考

- Issue #393: feat: 定时扫描 PR 并创建讨论群聊
- Issue #631: feat: 离线提问 - Agent 不阻塞工作的留言机制
- Issue #946: AI 请求 review 时应提供御书房批奏折般的丝滑体验
- `schedules/pr-scanner.md`: PR Scanner 调度文件
- `src/mcp/tools/ask-user.ts`: 现有 ask_user 实现
- `docs/designs/pr-scanner-design.md`: PR Scanner 设计文档
