---
name: "临时会话管理"
cron: "0 */5 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# 临时会话管理

定期扫描临时会话文件，管理完整的会话生命周期：激活 pending 会话、过期超时的 active 会话、清理历史会话。

## 执行步骤

### 1. 扫描 pending 会话

列出所有待激活的会话：

```bash
for f in workspace/temporary-sessions/*.json; do
  [ -f "$f" ] || continue
  STATUS=$(jq -r '.status' "$f")
  if [ "$STATUS" = "pending" ]; then
    jq -c '{id, expiresAt, createGroup}' "$f"
  fi
done
```

如果返回为空，跳转到步骤 3。

### 2. 激活 pending 会话

对每个 pending 会话，按顺序执行以下操作：

#### 2.1 创建群聊

调用 `create_chat` MCP 工具创建群聊：

```
create_chat({
  name: "{createGroup.name}",
  memberIds: {createGroup.memberIds}
})
```

从返回结果中获取 `chatId`。

#### 2.2 发送交互卡片

调用 `send_interactive` MCP 工具向新群聊发送交互卡片：

```
send_interactive({
  chatId: "{从上一步获取的 chatId}",
  title: "{会话标题，如 createGroup.name}",
  question: "{message 字段内容}",
  options: {options 数组},
  actionPrompts: {actionPrompts 对象}
})
```

**重要**: `actionPrompts` 必须包含 session ID，确保用户点击按钮后 Agent 能路由到正确的会话。

#### 2.3 更新会话状态

创建群聊成功后，使用 Bash 更新会话文件：

```bash
SESSION_ID="{会话 ID}"
CHAT_ID="{从 create_chat 获取的 chatId}"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

jq --arg chatId "$CHAT_ID" --arg now "$NOW" \
  '.status = "active" | .chatId = $chatId | .activatedAt = $now' \
  "workspace/temporary-sessions/${SESSION_ID}.json" > "workspace/temporary-sessions/${SESSION_ID}.json.tmp" \
  && mv "workspace/temporary-sessions/${SESSION_ID}.json.tmp" "workspace/temporary-sessions/${SESSION_ID}.json"
```

**错误处理**: 如果 `create_chat` 或 `send_interactive` 失败，不要更新会话状态。下次 Schedule 执行时会重试。

### 3. 检查超时的 active 会话

列出所有需要过期的 active 会话：

```bash
NOW_EPOCH=$(date -u +%s)
for f in workspace/temporary-sessions/*.json; do
  [ -f "$f" ] || continue
  STATUS=$(jq -r '.status' "$f")
  if [ "$STATUS" = "active" ]; then
    EXPIRES_AT=$(jq -r '.expiresAt // empty' "$f")
    if [ -n "$EXPIRES_AT" ]; then
      EXPIRES_EPOCH=$(date -u -d "$EXPIRES_AT" +%s 2>/dev/null || echo 0)
      if [ "$NOW_EPOCH" -ge "$EXPIRES_EPOCH" ]; then
        jq -c '{id, chatId, expiresAt}' "$f"
      fi
    fi
  fi
done
```

如果返回为空，跳转到步骤 5。

### 4. 过期超时的 active 会话

对每个超时的 active 会话：

#### 4.1 解散群聊

如果会话有 `chatId`，调用 `dissolve_chat` MCP 工具：

```
dissolve_chat({
  chatId: "{会话的 chatId}"
})
```

#### 4.2 更新会话状态

```bash
SESSION_ID="{会话 ID}"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

jq --arg now "$NOW" \
  '.status = "expired" | .response = .response // {value: "timeout", respondedAt: $now}' \
  "workspace/temporary-sessions/${SESSION_ID}.json" > "workspace/temporary-sessions/${SESSION_ID}.json.tmp" \
  && mv "workspace/temporary-sessions/${SESSION_ID}.json.tmp" "workspace/temporary-sessions/${SESSION_ID}.json"
```

### 5. 清理过期会话文件

删除已过期超过 24 小时的会话文件：

```bash
NOW_EPOCH=$(date -u +%s)
for f in workspace/temporary-sessions/*.json; do
  [ -f "$f" ] || continue
  STATUS=$(jq -r '.status' "$f")
  if [ "$STATUS" = "expired" ]; then
    # Check response.respondedAt or activatedAt for cleanup timing
    RESPONDED_AT=$(jq -r '.response.respondedAt // .activatedAt // empty' "$f")
    if [ -n "$RESPONDED_AT" ]; then
      RESPONDED_EPOCH=$(date -u -d "$RESPONDED_AT" +%s 2>/dev/null || echo 0)
      if [ $(( NOW_EPOCH - RESPONDED_EPOCH )) -gt 86400 ]; then
        rm "$f"
      fi
    fi
  fi
done
```

## 状态管理

### 状态转换

```
创建文件(pending) → Schedule激活(active) → 用户响应/超时(expired) → 24h后清理
```

### 错误处理

| 场景 | 处理方式 |
|------|---------|
| `create_chat` 失败 | 跳过该会话，下次重试 |
| `send_interactive` 失败 | 跳过该会话，下次重试 |
| `dissolve_chat` 失败 | 仍然标记为 expired，避免无限重试 |
| 会话文件损坏（无效 JSON） | 跳过该文件，记录警告 |
| `workspace/temporary-sessions/` 不存在 | 创建目录，退出本次执行 |

## 注意事项

1. **串行处理**: 一次只处理一个 pending 会话，避免并发创建群聊
2. **幂等设计**: Schedule 是无状态的，所有状态通过文件管理
3. **原子写入**: 所有 JSON 更新使用 jq + tmp + mv 模式
4. **MCP 工具由 Agent 调用**: 群组操作和卡片发送不在 Bash 中执行

## 依赖

- `jq` (必需)
- MCP Tools: `create_chat`, `send_interactive`, `dissolve_chat`
- 目录: `workspace/temporary-sessions/`
