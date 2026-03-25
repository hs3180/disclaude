---
name: "Session Lifecycle Manager"
cron: "0 */5 * * * *"
enabled: true
blocking: false
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Session Lifecycle Manager

管理 `workspace/temporary-sessions/` 目录中的临时会话文件生命周期。
负责检测过期会话、清理已完成会话、发送超时通知。

## 配置

- **检查间隔**: 每 5 分钟
- **会话目录**: `workspace/temporary-sessions/`
- **默认超时**: 60 分钟（各会话文件通过 `expiresAt` 字段自定义）

## 会话文件约定

所有临时会话使用统一的 JSON 格式，存储在 `workspace/temporary-sessions/` 目录：

```json
{
  "status": "pending | active | expired",
  "chatId": "oc_xxx (群聊 chatId)",
  "messageId": "om_xxx (卡片消息 ID)",
  "createdAt": "2026-03-25T10:00:00Z",
  "expiresAt": "2026-03-25T11:00:00Z",
  "context": {},
  "response": null
}
```

### 命名规范

| 前缀 | 场景 | 示例 |
|------|------|------|
| `pr-` | PR 审核会话 | `pr-123.json` |
| `ask-` | Agent 提问会话 | `ask-review-20260325.json` |
| `offline-` | 离线提问会话 | `offline-deploy.json` |

### 通用字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `status` | string | ✅ | `pending` → `active` → `expired` |
| `chatId` | string\|null | ✅ | 关联的群聊 chatId |
| `messageId` | string\|null | ✅ | 发送的卡片消息 ID |
| `createdAt` | ISO 8601 | ✅ | 会话创建时间 |
| `expiresAt` | ISO 8601 | ✅ | 会话过期时间 |
| `context` | object | ✅ | 场景相关上下文（PR 编号、仓库等） |
| `response` | object\|null | ✅ | 用户响应结果 |

## 执行步骤

### 1. 扫描会话文件

```bash
# 列出所有会话文件
ls workspace/temporary-sessions/*.json 2>/dev/null | grep -v '.gitkeep'
```

如果目录为空或不存在，退出本次执行。

### 2. 检查每个会话状态

对每个会话文件执行以下检查：

```bash
# 读取会话状态和过期时间
status=$(cat {file} | jq -r '.status')
expires_at=$(cat {file} | jq -r '.expiresAt')
created_at=$(cat {file} | jq -r '.createdAt')

# 检查是否过期
now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
is_expired=$(node -e "
  const now = new Date('$now');
  const expires = new Date('$expires_at');
  console.log(now > expires ? 'true' : 'false');
")
```

### 3. 处理过期会话

对于已过期的会话（`is_expired = true` 且 `status != expired`）：

#### 3.1 发送超时通知（仅 active 状态）

如果会话处于 `active` 状态且已过期，向关联的 `chatId` 发送超时通知：

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "⏰ 会话已过期", "tag": "plain_text"}, "template": "orange"},
  "elements": [
    {"tag": "markdown", "content": "该讨论会话已超时未响应，已自动关闭。\n\n**会话类型**: {context 中的类型}\n**创建时间**: {createdAt}\n**过期时间**: {expiresAt}"}
  ]
}
```

#### 3.2 更新会话状态

```bash
# 将状态标记为 expired
cat {file} | jq '.status = "expired"' > /tmp/session-update.json && \
  mv /tmp/session-update.json {file}
```

#### 3.3 场景特定清理

根据会话的 `context` 类型执行不同的清理逻辑：

| context 类型 | 清理操作 |
|-------------|---------|
| `prNumber` 存在 | 移除 GitHub `pr-scanner:pending` label |
| `ask_*` 类型 | 无额外操作 |
| `offline_*` 类型 | 无额外操作 |

```bash
# PR 会话清理
if cat {file} | jq -e '.context.prNumber' > /dev/null 2>&1; then
  pr_number=$(cat {file} | jq -r '.context.prNumber')
  gh pr edit "$pr_number" --repo hs3180/disclaude --remove-label "pr-scanner:pending" 2>/dev/null
fi
```

### 4. 清理已过期的旧会话文件

对于状态为 `expired` 且超过 24 小时的会话文件，删除文件释放空间：

```bash
# 检查是否超过 24 小时
created_at=$(cat {file} | jq -r '.createdAt')
is_old=$(node -e "
  const created = new Date('$created_at');
  const now = new Date();
  const hours = (now - created) / (1000 * 60 * 60);
  console.log(hours > 24 ? 'true' : 'false');
")

# 删除旧文件
if [ "$is_old" = "true" ]; then
  rm {file}
fi
```

## 状态转换汇总

```
[创建] → pending (调用方 Schedule/Skill 写入文件)
  ↓
[群聊创建+消息发送完成] → active (调用方 Schedule 更新)
  ↓
[用户响应] → expired + response 填充 (actionPrompt 回调处理)
  或
[超过 expiresAt] → expired (本 Schedule 检测并处理)
  ↓
[超过 24 小时] → 删除文件 (本 Schedule 清理)
```

## 错误处理

- 如果读取会话文件失败（JSON 格式错误），记录警告并跳过该文件
- 如果发送超时通知失败，仍然更新状态为 expired
- 如果 GitHub Label 操作失败，记录错误但不影响会话状态更新

## 注意事项

1. **幂等性**: 多次执行不会产生副作用
2. **非阻塞**: `blocking: false`，不阻止其他 schedule 执行
3. **轻量级**: 仅做文件 I/O 和必要通知，不执行复杂业务逻辑
4. **兼容性**: 与 GitHub Label 状态管理共存，不强制替换
