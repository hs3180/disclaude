---
name: "Temporary Sessions Manager"
cron: "0 */1 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-03T00:00:00.000Z
---

# Temporary Sessions Manager

自动管理临时会话的生命周期：激活 pending 会话（创建群组 + 发送卡片）、过期 active 会话（解散群组）、清理 expired 会话文件。

## 配置

- **Session 目录**: `workspace/temporary-sessions/`
- **执行间隔**: 每 1 分钟
- **默认过期时间**: 24 小时
- **清理保留期**: 1 小时（expired 状态超过 1 小时后删除文件）

## 前置依赖

- `@larksuite/cli`（飞书官方 CLI，npm 全局安装）
- `jq`（JSON 处理工具）
- MCP 工具：`send_interactive`（发送交互卡片）

## 执行步骤

### Step 0: 环境检查

```bash
# 检查 lark-cli 是否可用
which lark-cli 2>/dev/null || echo "MISSING:lark-cli"

# 检查 jq 是否可用
which jq 2>/dev/null || echo "MISSING:jq"

# 确保 session 目录存在
mkdir -p workspace/temporary-sessions
```

如果 `lark-cli` 或 `jq` 缺失，发送错误通知到 chatId 并终止执行。

### Step 1: 列出 pending 会话

```bash
# 查找所有 pending 状态的会话
for f in workspace/temporary-sessions/*.json; do
  [ -f "$f" ] || continue
  status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$status" = "pending" ]; then
    echo "$f"
  fi
done
```

### Step 2: 激活 pending 会话

对每个 pending 会话执行以下操作：

#### 2.1 读取会话数据

```bash
id=$(jq -r '.id' "$f")
group_name=$(jq -r '.createGroup.name' "$f")
members=$(jq -r '.createGroup.members | join(",")' "$f")
message=$(jq -r '.message' "$f")
expires_at=$(jq -r '.expiresAt' "$f")
options_json=$(jq -c '.options' "$f")
```

#### 2.2 通过 lark-cli 创建群组

```bash
# 创建群组并获取 chatId
result=$(lark-cli im +chat-create \
  --name "$group_name" \
  --users "$members" 2>&1)

chat_id=$(echo "$result" | jq -r '.chat_id // .data.chat_id // empty')

if [ -z "$chat_id" ]; then
  echo "ERROR: Failed to create group for session $id"
  echo "$result"
  continue
fi
```

#### 2.3 发送交互卡片到新群组

使用 `send_interactive` MCP 工具发送卡片到新创建的群组：

**卡片配置**：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"content": "🔔 临时会话待处理", "tag": "plain_text"},
    "template": "blue"
  },
  "elements": [
    {"tag": "markdown", "content": "{message}"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      // 从 session.options 动态生成按钮
      {"tag": "button", "text": {"content": "{option.text}", "tag": "plain_text"}, "value": "session-action:{id}:{option.value}"}
    ]}
  ]
}
```

**actionPrompts**（每个选项对应一个）：
```json
{
  "session-action:{id}:{option.value}": "[用户操作] 用户在临时会话 {id} 中选择了 {option.value}"
}
```

**关键设计**：
- `chatId` 使用新创建的群组 `chat_id`（不是 schedule 的 chatId）
- 按钮的 `value` 格式为 `session-action:{sessionId}:{actionValue}`，确保可路由
- action prompt 包含 session ID，Skill 可据此更新对应 session 文件

#### 2.4 更新会话状态为 active

```bash
now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

jq --arg chat_id "$chat_id" \
    --arg now "$now" \
    '.status = "active" |
     .chatId = $chat_id |
     .activatedAt = $now' "$f" > /tmp/session-update.json \
  && mv /tmp/session-update.json "$f"
```

### Step 3: 检查过期的 active 会话

```bash
now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

for f in workspace/temporary-sessions/*.json; do
  [ -f "$f" ] || continue
  status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$status" != "active" ]; then
    continue
  fi

  expires_at=$(jq -r '.expiresAt' "$f")

  # 比较 expiresAt 与当前时间
  if [ "$now" \> "$expires_at" ] || [ "$now" = "$expires_at" ]; then
    echo "EXPIRED:$f"
  fi
done
```

### Step 4: 处理过期会话

对每个过期的 active 会话：

#### 4.1 检查是否有用户响应

```bash
has_response=$(jq -r '.response // null' "$f")
chat_id=$(jq -r '.chatId' "$f")
```

#### 4.2 解散群组（仅当没有响应时）

如果用户未响应（超时过期），解散群组：

```bash
if [ "$has_response" = "null" ] && [ -n "$chat_id" ]; then
  # 通过 lark-cli 解散群组
  lark-cli api DELETE "/open-apis/im/v1/chats/$chat_id" 2>&1
fi
```

> **注意**：如果用户已响应，群组由用户自行管理，不自动解散。

#### 4.3 更新会话状态为 expired

```bash
jq '.status = "expired"' "$f" > /tmp/session-update.json \
  && mv /tmp/session-update.json "$f"
```

### Step 5: 清理过期的 expired 会话文件

```bash
now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
# 保留期：1 小时
cleanup_before=$(date -u -d "1 hour ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                 date -u -v-1H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)

for f in workspace/temporary-sessions/*.json; do
  [ -f "$f" ] || continue
  status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$status" != "expired" ]; then
    continue
  fi

  # 检查响应时间或过期时间
  last_activity=$(jq -r '
    if .response and .response.repliedAt then .response.repliedAt
    elif .expiresAt then .expiresAt
    else .createdAt
    end' "$f")

  if [ "$cleanup_before" \> "$last_activity" ]; then
    rm "$f"
    echo "CLEANED:$f"
  fi
done
```

## 状态转换总结

| 当前状态 | 条件 | 执行动作 | 新状态 |
|----------|------|----------|--------|
| `pending` | 文件存在 | 创建群组 + 发送卡片 | `active` |
| `active` | `now >= expiresAt` 且无响应 | 解散群组 | `expired` |
| `active` | `now >= expiresAt` 且有响应 | （不解散群组） | `expired` |
| `expired` | 超过清理保留期 | 删除文件 | （移除） |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `lark-cli` 不可用 | 发送通知到 chatId，终止执行 |
| 创建群组失败 | 记录错误，跳过该会话，下次重试 |
| 发送卡片失败 | 记录错误，跳过该会话，下次重试 |
| 解散群组失败 | 记录错误，不影响状态更新 |
| Session 文件损坏（非 JSON） | 记录错误，跳过该文件 |
| `jq` 不可用 | 尝试用 `python3` 作为 fallback |

## 注意事项

1. **幂等性**: 每个 Step 都是幂等的，重复执行不会产生副作用
2. **无状态**: Schedule 不维护内存状态，所有状态从文件读取
3. **串行处理**: 一次处理一个会话，避免并发问题
4. **不创建新 Schedule**: 这是定时任务执行环境的规则
5. **不修改其他 Schedule**: 只处理 temporary-sessions 目录下的文件

## 验收标准

- [ ] 能检测并激活 pending 会话（创建群组 + 发送卡片）
- [ ] 能检测并处理过期的 active 会话（解散群组或保留）
- [ ] 能清理超过保留期的 expired 会话文件
- [ ] 错误情况下不影响其他会话的处理
- [ ] 环境依赖缺失时能发送通知
