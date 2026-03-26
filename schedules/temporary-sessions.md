---
name: "临时会话管理"
cron: "0 */5 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# 临时会话管理

定期扫描临时会话文件，管理完整的会话生命周期：激活 pending 会话、过期超时的 active 会话、清理历史会话。

## 配置

- **扫描间隔**: 每 5 分钟
- **最大重试次数**: 10 次
- **过期清理延迟**: 24 小时

## 依赖

- **`jq`** (必需) — JSON 处理
- **`flock`** (必需) — 文件锁，防止并发写入冲突（`util-linux` 包提供）
- **`date -d`** (必需) — GNU coreutils 语法，用于相对时间计算。macOS 需使用 Homebrew 的 `gdate`
- **MCP Tools**: `create_chat`, `send_interactive`, `dissolve_chat`
- **目录**: `workspace/temporary-sessions/`

## 执行步骤

### 0. 环境检查

**目录存在性检查**（每次执行前必须检查）：

```bash
SESSION_DIR="workspace/temporary-sessions"
LOCK_FILE="${SESSION_DIR}/.lock"

if [ ! -d "$SESSION_DIR" ]; then
  mkdir -p "$SESSION_DIR"
  echo '{"event":"dir_created","path":"'"$SESSION_DIR"'"}'
  echo "Created session directory, exiting this run."
  exit 0
fi

# Ensure lock file exists
touch "$LOCK_FILE"
```

### 1. 扫描 pending 会话

列出所有待激活的会话（包含 Agent 激活所需的全部字段）：

```bash
SESSION_DIR="workspace/temporary-sessions"
NOW_EPOCH=$(date -u +%s)

for f in "$SESSION_DIR"/*.json; do
  [ -f "$f" ] || continue

  # JSON corruption tolerance: skip invalid files
  STATUS=$(jq -r '.status' "$f" 2>/dev/null) || {
    echo '{"event":"invalid_json","file":"'"$(basename "$f")"'"}'
    continue
  }

  if [ "$STATUS" = "pending" ]; then
    # Output ALL fields Agent needs for activation:
    # id, expiresAt, createGroup (for create_chat)
    # message, options, actionPrompts (for send_interactive)
    # retryCount, lastError (for failure tracking)
    jq -c '.' "$f" 2>/dev/null || {
      echo '{"event":"invalid_json","file":"'"$(basename "$f")"'"}'
      continue
    }
  fi
done
```

如果返回为空，跳转到步骤 3。

### 2. 激活 pending 会话

对每个 pending 会话，**串行处理**（一次只处理一个），按顺序执行以下操作：

#### 2.1 创建群聊

调用 `create_chat` MCP 工具创建群聊：

```
create_chat({
  name: "{createGroup.name}",
  memberIds: {createGroup.memberIds}
})
```

从返回结果中获取 `chatId`。如果返回 `success: false`，执行以下错误处理：

```bash
SESSION_ID="{会话 ID}"
TARGET="workspace/temporary-sessions/${SESSION_ID}.json"
ERROR_MSG="{create_chat 返回的错误信息}"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

(
  flock -x 200
  jq --arg error "$ERROR_MSG" \
    '.retryCount = (.retryCount // 0) + 1 | .lastError = $error |
     if .retryCount >= 10 then .status = "failed" else . end' \
    "$TARGET" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "$TARGET"
  echo '{"event":"activation_failed","sessionId":"'"$SESSION_ID"'","step":"create_chat","retryCount":'$(jq '.retryCount' "$TARGET")'}'
) 200>"workspace/temporary-sessions/.lock"
```

如果 `retryCount >= 10`，会话自动标记为 `failed`，不再重试。跳到下一个 pending 会话。

#### 2.2 发送交互卡片

`create_chat` 成功后，调用 `send_interactive` MCP 工具向新群聊发送交互卡片：

```
send_interactive({
  chatId: "{从上一步获取的 chatId}",
  title: "{createGroup.name}",
  question: "{message 字段内容}",
  options: {options 数组},
  actionPrompts: {actionPrompts 对象}
})
```

如果 `send_interactive` 失败，使用与 2.1 相同的错误处理逻辑（递增 retryCount，达到 10 次标记为 failed）。

**重要**: `actionPrompts` 中的每个值必须包含 `(session: {id})` 格式的 session ID，确保用户点击按钮后 Agent 能路由到正确的会话。

#### 2.3 更新会话状态

创建群聊并发送卡片均成功后，使用 Bash 更新会话文件：

```bash
SESSION_ID="{会话 ID}"
CHAT_ID="{从 create_chat 获取的 chatId}"
TARGET="workspace/temporary-sessions/${SESSION_ID}.json"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

(
  flock -x 200
  jq --arg chatId "$CHAT_ID" --arg now "$NOW" \
    '.status = "active" | .chatId = $chatId | .activatedAt = $now | .retryCount = 0 | .lastError = null' \
    "$TARGET" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "$TARGET"
  echo '{"event":"activated","sessionId":"'"$SESSION_ID"'","chatId":"'"$CHAT_ID"'"}'
) 200>"workspace/temporary-sessions/.lock"
```

### 3. 检查超时的 active 会话

列出所有需要过期的 active 会话：

```bash
SESSION_DIR="workspace/temporary-sessions"
NOW_EPOCH=$(date -u +%s)

for f in "$SESSION_DIR"/*.json; do
  [ -f "$f" ] || continue

  STATUS=$(jq -r '.status' "$f" 2>/dev/null) || {
    echo '{"event":"invalid_json","file":"'"$(basename "$f")"'"}'
    continue
  }

  if [ "$STATUS" = "active" ]; then
    EXPIRES_AT=$(jq -r '.expiresAt // empty' "$f" 2>/dev/null)
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

**如果 `dissolve_chat` 成功**：

```bash
SESSION_ID="{会话 ID}"
TARGET="workspace/temporary-sessions/${SESSION_ID}.json"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

(
  flock -x 200
  jq --arg now "$NOW" \
    '.status = "expired" | .dissolveFailed = false |
     .response = (.response // {value: "timeout", respondedAt: $now})' \
    "$TARGET" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "$TARGET"
  echo '{"event":"expired","sessionId":"'"$SESSION_ID"'","dissolved":true}'
) 200>"workspace/temporary-sessions/.lock"
```

**如果 `dissolve_chat` 失败**（孤儿群组恢复机制）：

```bash
SESSION_ID="{会话 ID}"
TARGET="workspace/temporary-sessions/${SESSION_ID}.json"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

(
  flock -x 200
  jq --arg now "$NOW" --arg error "{dissolve_chat 返回的错误信息}" \
    '.status = "orphaned" | .dissolveFailed = true | .lastError = $error |
     .response = (.response // {value: "timeout", respondedAt: $now})' \
    "$TARGET" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "$TARGET"
  echo '{"event":"expired","sessionId":"'"$SESSION_ID"'","dissolved":false,"status":"orphaned"}'
) 200>"workspace/temporary-sessions/.lock"
```

### 4.3 重试解散孤儿群组

在每次 Schedule 执行的步骤 3 中，除了检查 `active` 会话，还需检查 `orphaned` 状态的会话并重试解散：

```bash
# Add to the Step 3 loop, alongside the active check:
if [ "$STATUS" = "orphaned" ]; then
  jq -c '{id, chatId, expiresAt, lastError}' "$f"
fi
```

对 `orphaned` 会话执行与步骤 4.1-4.2 相同的 `dissolve_chat` 流程。如果成功，状态更新为 `expired`。

### 5. 清理过期会话文件

删除已过期超过 24 小时的会话文件（`expired` 和 `orphaned` 状态均清理）：

```bash
SESSION_DIR="workspace/temporary-sessions"
NOW_EPOCH=$(date -u +%s)
CLEANUP_THRESHOLD=86400  # 24 hours in seconds

for f in "$SESSION_DIR"/*.json; do
  [ -f "$f" ] || continue

  STATUS=$(jq -r '.status' "$f" 2>/dev/null) || {
    echo '{"event":"invalid_json","file":"'"$(basename "$f")"'"}'
    continue
  }

  if [ "$STATUS" = "expired" ] || [ "$STATUS" = "orphaned" ]; then
    # Use response.respondedAt for timing (all expired sessions have this field)
    RESPONDED_AT=$(jq -r '.response.respondedAt // empty' "$f" 2>/dev/null)
    if [ -n "$RESPONDED_AT" ]; then
      RESPONDED_EPOCH=$(date -u -d "$RESPONDED_AT" +%s 2>/dev/null || echo 0)
      if [ $(( NOW_EPOCH - RESPONDED_EPOCH )) -gt "$CLEANUP_THRESHOLD" ]; then
        rm "$f"
        echo '{"event":"cleaned","file":"'"$(basename "$f")"'"}'
      fi
    fi
  fi

  # Also clean up failed sessions older than 24 hours
  if [ "$STATUS" = "failed" ]; then
    LAST_ERROR_TIME=$(jq -r '.lastError // empty' "$f" 2>/dev/null)
    # Failed sessions don't have a timestamp in lastError, use createdAt
    CREATED_AT=$(jq -r '.createdAt // empty' "$f" 2>/dev/null)
    if [ -n "$CREATED_AT" ]; then
      CREATED_EPOCH=$(date -u -d "$CREATED_AT" +%s 2>/dev/null || echo 0)
      if [ $(( NOW_EPOCH - CREATED_EPOCH )) -gt "$CLEANUP_THRESHOLD" ]; then
        rm "$f"
        echo '{"event":"cleaned","file":"'"$(basename "$f")"'"}'
      fi
    fi
  fi
done
```

## 状态管理

### 状态转换

```
创建文件(pending) → Schedule激活(active) → 用户响应/超时(expired) → 24h后清理
        ↓                ↓                      ↓
     failed         dissolve失败 → orphaned → 重试成功 → expired
                                        ↓
                                     24h后清理
```

### 错误处理

| 场景 | 处理方式 |
|------|---------|
| `create_chat` 失败 | 递增 retryCount，记录 lastError；达到 10 次标记为 `failed`，发送通知 |
| `send_interactive` 失败 | 递增 retryCount，记录 lastError；达到 10 次标记为 `failed` |
| `dissolve_chat` 失败 | 标记为 `orphaned`（记录 `dissolveFailed: true`），后续 Schedule 重试解散 |
| 会话文件损坏（无效 JSON） | 跳过该文件，输出结构化警告日志 |
| `workspace/temporary-sessions/` 不存在 | 创建目录，输出日志，退出本次执行 |
| 会话 ID 冲突（文件已存在） | 拒绝创建，输出错误 |

### 结构化日志

所有状态转换均输出 JSON 格式的结构化日志，便于监控和调试：

| 事件 | 触发时机 |
|------|---------|
| `{"event":"dir_created"}` | 首次创建会话目录 |
| `{"event":"invalid_json"}` | 跳过损坏的 JSON 文件 |
| `{"event":"created"}` | 会话文件创建成功 |
| `{"event":"activated"}` | 会话激活成功（群聊已创建） |
| `{"event":"activation_failed"}` | 激活失败（含 retryCount 和失败步骤） |
| `{"event":"responded"}` | 用户点击按钮响应 |
| `{"event":"expired"}` | 会话过期（含 dissolved 状态） |
| `{"event":"cleaned"}` | 过期文件已清理 |

## 注意事项

1. **串行处理**: 一次只处理一个 pending 会话，避免并发创建群聊
2. **幂等设计**: Schedule 是无状态的，所有状态通过文件管理，重复执行安全
3. **原子写入**: 所有 JSON 更新使用 `jq` + `.tmp` + `mv` 模式
4. **并发安全**: 文件写入使用 `flock` 保护，防止并发冲突
5. **MCP 工具由 Agent 调用**: 群组操作和卡片发送不在 Bash 中执行
6. **JSON 容错**: 所有关键 `jq` 调用后检查退出码，损坏文件跳过并记录警告
