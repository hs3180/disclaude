---
name: "Chats Activation"
cron: "0 * * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-03T00:00:00.000Z
---

# Chats Activation

自动激活 pending 状态的临时群聊：通过 `lark-cli` 创建群组，更新状态为 active。对反复失败的群聊自动标记为 failed，避免无限重试。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每 1 分钟

## 前置依赖

- `@larksuite/cli`（飞书官方 CLI，npm 全局安装）
- `jq`（JSON 处理工具）

## 职责边界

- ✅ 创建群组（通过 `lark-cli`）
- ✅ 更新状态（pending → active）
- ✅ 标记失败（达到重试上限后 → failed）
- ❌ 不发送消息到群组（由消费方 skill 负责）
- ❌ 不处理超时/解散群组（由 `chat-timeout` skill 负责）
- ❌ 不清理文件（由 `chats-cleanup` schedule 负责）

## 执行步骤

### Step 0: 环境检查

```bash
# 检查 lark-cli 是否可用
which lark-cli 2>/dev/null || echo "MISSING:lark-cli"

# 检查 jq 是否可用
which jq 2>/dev/null || echo "MISSING:jq"

# 确保 chat 目录存在
mkdir -p workspace/chats
```

如果 `lark-cli` 或 `jq` 缺失，发送错误通知到 chatId 并终止执行。

### Step 1: 列出 pending 群聊

```bash
# 查找所有 pending 状态的群聊
for f in workspace/chats/*.json; do
  [ -f "$f" ] || continue
  status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$status" = "pending" ]; then
    echo "$f"
  fi
done
```

如果没有 pending 群聊，终止执行。

### Step 2: 激活 pending 群聊

对每个 pending 群聊执行以下操作：

#### 2.1 读取数据

```bash
id=$(jq -r '.id' "$f")
group_name=$(jq -r '.createGroup.name' "$f")
members=$(jq -r '.createGroup.members | join(",")' "$f")
attempts=$(jq -r '.activationAttempts // 0' "$f")
```

#### 2.2 使用 flock 防止并发竞态

对每个 chat 文件加排他锁，防止多个 Schedule 实例同时处理同一文件：

```bash
exec 9>"${f}.lock"

if ! flock -n 9; then
  echo "INFO: Chat $id is being processed by another instance, skipping"
  continue
fi

# 幂等检查：群组是否已创建（Schedule 崩溃恢复场景）
existing_chat_id=$(jq -r '.chatId // empty' "$f")

if [ -n "$existing_chat_id" ]; then
  echo "INFO: Chat $id already has chatId=$existing_chat_id, recovering to active"
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  tmpfile=$(mktemp "${f}.XXXXXX")
  jq --arg now "$now" \
      '.status = "active" | .activatedAt = $now' "$f" > "$tmpfile" \
    && mv "$tmpfile" "$f"
  exec 9>&-
  continue
fi
```

#### 2.3 通过 lark-cli 创建群组（带超时保护）

```bash
# 创建群组 — 分离 stdout 和 stderr（使用 mktemp 避免并发竞争）
# 30 秒超时保护，防止 lark-cli 挂起阻塞后续 Schedule
LARK_TIMEOUT=30
tmp_err=$(mktemp /tmp/lark-cli-err-XXXXXX)
result=$(timeout $LARK_TIMEOUT lark-cli im +chat-create \
  --name "$group_name" \
  --users "$members" 2>"$tmp_err")
exit_code=$?

if [ $exit_code -ne 0 ]; then
  if [ $exit_code -eq 124 ]; then
    error_msg="lark-cli timed out after ${LARK_TIMEOUT}s"
  else
    error_msg=$(cat "$tmp_err" 2>/dev/null | head -5)
  fi
  echo "ERROR: lark-cli exited with code $exit_code: $error_msg"
  rm -f "$tmp_err"
fi
rm -f "$tmp_err"

chat_id=$(echo "$result" | jq -r '.data.chat_id // empty')
```

#### 2.4 处理创建结果

```bash
MAX_RETRIES=5
now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
new_attempts=$((attempts + 1))

if [ -n "$chat_id" ]; then
  # ✅ 创建成功 — 更新为 active（临时文件与目标同目录，确保 mv 原子性）
  tmpfile=$(mktemp "${f}.XXXXXX")
  jq --arg chat_id "$chat_id" \
      --arg now "$now" \
      '.status = "active" |
       .chatId = $chat_id |
       .activatedAt = $now |
       .activationAttempts = 0 |
       .lastActivationError = null' "$f" > "$tmpfile" \
    && mv "$tmpfile" "$f"
else
  # ❌ 创建失败 — 记录错误并判断是否达到上限
  error_msg=${error_msg:-$(echo "$result" | head -5)}
  echo "ERROR: Failed to create group for chat $id (attempt $new_attempts/$MAX_RETRIES)"
  echo "$error_msg"

  if [ "$new_attempts" -ge "$MAX_RETRIES" ]; then
    echo "WARN: Chat $id reached max retries ($MAX_RETRIES), marking as failed"
    tmpfile=$(mktemp "${f}.XXXXXX")
    jq --arg now "$now" \
        --arg error "$error_msg" \
        '.status = "failed" |
         .activationAttempts = $new_attempts |
         .lastActivationError = $error |
         .failedAt = $now' "$f" > "$tmpfile" \
      && mv "$tmpfile" "$f"
    # 释放文件锁
    exec 9>&-
    # 📢 通知：群聊激活失败，告知用户
    notify_chat_id=$(jq -r '.createGroup.notifyChatId // empty' "$f")
    if [ -n "$notify_chat_id" ]; then
      echo "NOTIFY: Sending failure notification to $notify_chat_id for chat $id"
    fi
    echo "NOTIFY: Chat '$id' activation failed after $MAX_RETRIES retries: $error_msg"
    continue
  else
    tmpfile=$(mktemp "${f}.XXXXXX")
    jq --arg now "$now" \
        --arg error "$error_msg" \
        '.activationAttempts = $new_attempts |
         .lastActivationError = $error' "$f" > "$tmpfile" \
      && mv "$tmpfile" "$f"
  fi
fi

# 释放文件锁
exec 9>&-
```

## 状态转换

| 当前状态 | 条件 | 执行动作 | 新状态 |
|----------|------|----------|--------|
| `pending` | chatId 已存在 | 恢复状态（幂等） | `active` |
| `pending` | 群组创建成功 | 创建群组 + 更新状态 | `active` |
| `pending` | 创建失败且未达上限 | 记录错误 + 递增计数器 | `pending` |
| `pending` | 创建失败且达上限（5次） | 记录错误 | `failed` |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `lark-cli` 不可用 | 发送通知到 chatId，终止执行 |
| 创建群组失败（< 5 次） | 记录错误，递增重试计数器，下次重试 |
| 创建群组失败（≥ 5 次） | 标记为 `failed`，输出通知消息供消费方处理 |
| Schedule 崩溃后恢复 | 检测已有 chatId，幂等恢复为 `active` |
| Chat 文件损坏（非 JSON） | 记录错误，跳过该文件 |
| `lark-cli` 超时（> 30s） | 视为创建失败，记录超时错误，进入重试流程 |
| 并发处理同一文件 | `flock -n` 非阻塞锁，跳过已被其他实例处理的文件 |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用（检测已有 chatId 自动恢复）
2. **有限重试**: 创建失败最多重试 5 次，超限后标记为 `failed`
3. **无状态**: Schedule 不维护内存状态，所有状态从文件读取
4. **串行处理**: 一次处理一个群聊，避免并发问题
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只处理 `workspace/chats/` 目录下的文件
7. **并发安全**: 使用 `flock` 文件锁防止多个 Schedule 实例同时处理同一文件
8. **超时保护**: `lark-cli` 调用设 30 秒超时，防止挂起阻塞后续 Schedule
9. **失败通知**: 达到重试上限后输出通知消息，消费方可据此通知用户

## 验收标准

- [ ] 能检测并激活 pending 群聊（创建群组）
- [ ] 能正确更新状态为 active
- [ ] 创建群组失败时不影响其他群聊
- [ ] 崩溃恢复后不会重复创建群组（幂等性）
- [ ] 连续失败 5 次后被标记为 failed
- [ ] 环境依赖缺失时能发送通知
