---
name: "Temporary Session Manager"
cron: "0 */5 * * * *"
enabled: true
blocking: true
chatId: "${TEMP_SESSION_CHAT_ID}"
---

# Temporary Session Manager - 临时会话管理器

定期扫描和管理临时会话的生命周期：激活 pending 会话、检查超时、清理过期会话。

## 配置

- **扫描间隔**: 每 5 分钟
- **默认超时**: 60 分钟（可在会话文件中通过 `timeoutMinutes` 自定义）
- **清理延迟**: 过期 24 小时后删除会话文件
- **脚本目录**: `skills/temporary-session/scripts/`

## 前置条件

- 环境变量 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET` 已设置，或存在 `disclaude.config.yaml` 配置文件
- 已安装 `curl` 和 `jq`（用于脚本执行）

## 执行步骤

### 1. 检查会话目录

```bash
SESSIONS_DIR="workspace/temporary-sessions"

if [[ ! -d "$SESSIONS_DIR" ]]; then
  # No sessions exist, nothing to do
  exit 0
fi

# List all session files
ls "$SESSIONS_DIR"/*.json 2>/dev/null || exit 0
```

### 2. 处理 pending 会话 → 激活

遍历所有 `status: "pending"` 的会话文件：

```bash
for session_file in "$SESSIONS_DIR"/*.json; do
  STATUS=$(grep -o '"status":"[^"]*"' "$session_file" | head -1 | sed 's/"status":"//;s/"//')

  if [[ "$STATUS" != "pending" ]]; then
    continue
  fi

  SESSION_ID=$(grep -o '"id":"[^"]*"' "$session_file" | head -1 | sed 's/"id":"//;s/"//')
  TOPIC=$(grep -o '"topic":"[^"]*"' "$session_file" | head -1 | sed 's/"topic":"//;s/"//')
  SOURCE_CHAT=$(grep -o '"sourceChatId":"[^"]*"' "$session_file" | head -1 | sed 's/"sourceChatId":"//;s/"//')
  MEMBERS=$(grep -o '"members":\[[^]]*\]' "$session_file" | head -1 | sed 's/"members"://;s/\[//;s/\]//;s/"//g')

  # 2.1 Validate session ID (prevent path traversal)
  if ! echo "$SESSION_ID" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'; then
    echo "Invalid session ID: $SESSION_ID, deleting file"
    rm "$session_file"
    continue
  fi

  # 2.2 Create group using script
  GROUP_NAME="讨论: ${TOPIC}"
  if [[ -n "$MEMBERS" ]]; then
    RESULT=$(bash skills/temporary-session/scripts/create-group.sh --name "$GROUP_NAME" --members "$MEMBERS")
  else
    RESULT=$(bash skills/temporary-session/scripts/create-group.sh --name "$GROUP_NAME")
  fi

  CHAT_ID=$(echo "$RESULT" | grep -o '"chatId":"[^"]*"' | sed 's/"chatId":"//;s/"//')
  SUCCESS=$(echo "$RESULT" | grep -o '"success":true')

  if [[ -n "$SUCCESS" && -n "$CHAT_ID" ]]; then
    # 2.3 Update session to active status
    NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
    # Use sed for atomic update: write to tmp then rename
    sed "s/\"status\": \"pending\"/\"status\": \"active\"/" "$session_file" > "${session_file}.tmp"
    sed -i "s/\"chatId\": null/\"chatId\": \"${CHAT_ID}\"/" "${session_file}.tmp"
    sed -i "s/\"activatedAt\": null/\"activatedAt\": \"${NOW}\"/" "${session_file}.tmp"
    mv "${session_file}.tmp" "$session_file"

    # 2.4 Send context message to the group
    # Read context from session file
    CONTEXT=$(grep -o '"context":"[^"]*"' "$session_file" | head -1 | sed 's/"context":"//;s/"//')

    # Send the context as a card to the new group
    # Use mcp__channel-mcp__send_interactive with:
    # - chatId: $CHAT_ID
    # - card content including the topic and context
    # - action buttons for user response (e.g., "完成", "需要更多时间", "取消")

  else
    # Group creation failed - send error to source chat
    ERROR=$(echo "$RESULT" | grep -o '"error":"[^"]*"' | sed 's/"error":"//;s/"//' || echo "Unknown error")
    # Use mcp__channel-mcp__send_text to notify source chat about failure
    echo "Failed to create group for session $SESSION_ID: $ERROR"
  fi
done
```

### 3. 检查 active 会话超时

遍历所有 `status: "active"` 的会话，检查是否超时：

```bash
for session_file in "$SESSIONS_DIR"/*.json; do
  STATUS=$(grep -o '"status":"[^"]*"' "$session_file" | head -1 | sed 's/"status":"//;s/"//')

  if [[ "$STATUS" != "active" ]]; then
    continue
  fi

  SESSION_ID=$(grep -o '"id":"[^"]*"' "$session_file" | head -1 | sed 's/"id":"//;s/"//')
  CHAT_ID=$(grep -o '"chatId":"[^"]*"' "$session_file" | head -1 | sed 's/"chatId":"//;s/"//')
  ACTIVATED_AT=$(grep -o '"activatedAt":"[^"]*"' "$session_file" | head -1 | sed 's/"activatedAt":"//;s/"//')
  TIMEOUT=$(grep -o '"timeoutMinutes":[0-9]*' "$session_file" | head -1 | sed 's/"timeoutMinutes"://')
  SOURCE_CHAT=$(grep -o '"sourceChatId":"[^"]*"' "$session_file" | head -1 | sed 's/"sourceChatId":"//;s/"//')
  RESPONSE=$(grep -o '"response":"[^"]*"' "$session_file" | head -1 | sed 's/"response":"//;s/"//')

  # Default timeout: 60 minutes
  TIMEOUT=${TIMEOUT:-60}

  # 3.1 Check if response was received
  if [[ -n "$RESPONSE" && "$RESPONSE" != "null" ]]; then
    # Session has response, expire it
    NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
    sed "s/\"status\": \"active\"/\"status\": \"expired\"/" "$session_file" > "${session_file}.tmp"
    sed -i "s/\"expiredAt\": null/\"expiredAt\": \"${NOW}\"/" "${session_file}.tmp"
    mv "${session_file}.tmp" "$session_file"

    # Notify source chat about completion
    # Use mcp__channel-mcp__send_text to notify
    continue
  fi

  # 3.2 Check timeout
  if [[ -n "$ACTIVATED_AT" && "$ACTIVATED_AT" != "null" ]]; then
    ACTIVATED_EPOCH=$(date -d "$ACTIVATED_AT" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    TIMEOUT_SECONDS=$((TIMEOUT * 60))

    if (( NOW_EPOCH - ACTIVATED_EPOCH > TIMEOUT_SECONDS )); then
      # Session timed out, expire it
      NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
      sed "s/\"status\": \"active\"/\"status\": \"expired\"/" "$session_file" > "${session_file}.tmp"
      sed -i "s/\"expiredAt\": null/\"expiredAt\": \"${NOW}\"/" "${session_file}.tmp"
      mv "${session_file}.tmp" "$session_file"

      # Send timeout notification to group
      # Use mcp__channel-mcp__send_text with chatId: $CHAT_ID

      # Dissolve the group
      if [[ -n "$CHAT_ID" && "$CHAT_ID" != "null" ]]; then
        bash skills/temporary-session/scripts/dissolve-group.sh --chat-id "$CHAT_ID"
      fi

      # Notify source chat about timeout
      # Use mcp__channel-mcp__send_text with chatId: $SOURCE_CHAT
    fi
  fi
done
```

### 4. 清理过期会话文件

删除已过期超过 24 小时的会话文件：

```bash
# Delete expired session files older than 24 hours
find "$SESSIONS_DIR" -name "*.json" -mtime +1 -delete 2>/dev/null

# Also clean up any leftover .tmp files
find "$SESSIONS_DIR" -name "*.tmp" -mmin +5 -delete 2>/dev/null
```

## 状态转换规则

```
pending → active:    创建群聊成功后
active → expired:    收到用户响应 或 超时
expired → (deleted): 过期 24 小时后清理
```

**不允许的转换**:
- ❌ expired → active (不可复活)
- ❌ active → pending (不可回退)
- ❌ 任何状态 → 除了上述之外的转换

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| 脚本执行失败 | 记录错误，保持 pending 状态，下次重试 |
| 会话文件格式错误 | 删除文件，记录警告 |
| 群聊创建失败 | 通知来源群聊，保持 pending 状态 |
| 群聊解散失败 | 标记为 expired，下次清理时重试 |
| MCP 工具调用失败 | 记录错误，不阻塞后续处理 |

## 注意事项

1. **chatId 配置**: 此 Schedule 的 `chatId` 应通过环境变量 `TEMP_SESSION_CHAT_ID` 配置，不要硬编码
2. **无状态设计**: Schedule 不依赖内存状态，所有信息从 JSON 文件读取
3. **幂等性**: 多次执行不会产生副作用（检查状态后再转换）
4. **顺序处理**: 同一会话文件不会被并发处理（Schedule 设置为 `blocking: true`）

## 依赖

- Shell 脚本: `skills/temporary-session/scripts/create-group.sh`, `skills/temporary-session/scripts/dissolve-group.sh`
- 环境变量: `FEISHU_APP_ID`, `FEISHU_APP_SECRET`（或 `disclaude.config.yaml`）
- MCP 工具: `mcp__channel-mcp__send_text`, `mcp__channel-mcp__send_interactive`
- 外部工具: `curl`, `jq`（可选，用于 JSON 处理）
