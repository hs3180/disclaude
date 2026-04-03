---
name: "Temporary Session Cleanup"
cron: "0 */5 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-03T00:00:00.000Z
---

# Temporary Session Cleanup

定期检测超时的 active 临时会话，通过 `lark-cli` 解散对应群组，更新状态为 expired，并清理超过保留期的过期文件。

## 配置

- **Session 目录**: `workspace/temporary-sessions/`
- **执行间隔**: 每 5 分钟
- **过期保留期**: 1 小时（expired 状态文件超过此时间后被删除）

## 前置依赖

- `@larksuite/cli`（飞书官方 CLI，npm 全局安装）
- `jq`（JSON 处理工具）
- 临时会话核心功能（`temporary-session` Skill + `temporary-sessions` Schedule）已部署

## 职责边界

- ✅ 检测超时的 active 会话（`now >= expiresAt`）
- ✅ 通过 `lark-cli` 解散群组
- ✅ 更新会话状态为 expired
- ✅ 清理超过保留期的 expired 会话文件
- ❌ 不创建/激活会话（由 `temporary-sessions` Schedule 负责）
- ❌ 不发送消息到群组
- ❌ 不执行下游回调

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

### Step 1: 扫描 active 会话

```bash
# 查找所有 active 状态的会话
now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

expired_sessions=()
for f in workspace/temporary-sessions/*.json; do
  [ -f "$f" ] || continue
  status=$(jq -r '.status' "$f" 2>/dev/null)
  [ "$status" = "active" ] || continue

  expires_at=$(jq -r '.expiresAt' "$f" 2>/dev/null)
  if [[ "$now" >= "$expires_at" ]]; then
    expired_sessions+=("$f")
  fi
done

echo "Found ${#expired_sessions[@]} expired active session(s)"
```

如果没有超时会话，跳到 Step 4（仅执行清理）。

### Step 2: 处理每个超时会话

对每个超时会话执行以下操作：

#### 2.1 读取会话数据

```bash
for f in "${expired_sessions[@]}"; do
  id=$(jq -r '.id' "$f")
  chat_id=$(jq -r '.chatId' "$f")
  has_response=$(jq '.response != null' "$f")

  echo "Processing expired session: $id (response: $has_response)"
```

#### 2.2 解散群组

```bash
  if [ -n "$chat_id" ] && [ "$chat_id" != "null" ]; then
    result=$(lark-cli api DELETE "/open-apis/im/v1/chats/${chat_id}" 2>&1)

    if echo "$result" | jq -e '.code == 0' > /dev/null 2>&1; then
      echo "Dissolved group $chat_id for session $id"
    else
      echo "WARNING: Failed to dissolve group $chat_id — $result"
    fi
  else
    echo "Session $id has no chatId — skipping dissolution"
  fi
```

#### 2.3 更新状态为 expired

```bash
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  tmpfile=$(mktemp /tmp/session-timeout-XXXXXX.json)
  jq --arg now "$now" '.status = "expired" | .expiredAt = $now' "$f" > "$tmpfile" \
    && mv "$tmpfile" "$f"

  echo "Session $id marked as expired"
done
```

### Step 3: 汇报超时处理结果

将处理结果通知到 chatId：

```
📋 会话超时处理报告
> **检测**: N 个超时会话
> **群组解散**: N 成功 / N 失败
> **状态更新**: N 个会话已标记为 expired
```

### Step 4: 清理过期文件

删除超过保留期（1 小时）的 expired 会话文件：

```bash
retention_seconds=3600
now_epoch=$(date -u +"%s")
cleaned=0

for f in workspace/temporary-sessions/*.json; do
  [ -f "$f" ] || continue
  status=$(jq -r '.status' "$f" 2>/dev/null)
  [ "$status" = "expired" ] || continue

  expired_at=$(jq -r '.expiredAt // .expiresAt' "$f" 2>/dev/null)
  if [ -z "$expired_at" ] || [ "$expired_at" = "null" ]; then
    continue
  fi

  expired_epoch=$(date -u -d "$expired_at" +"%s" 2>/dev/null || \
                  date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$expired_at" +"%s" 2>/dev/null)
  [ -z "$expired_epoch" ] && continue

  age=$((now_epoch - expired_epoch))
  if [ "$age" -ge "$retention_seconds" ]; then
    rm "$f"
    cleaned=$((cleaned + 1))
  fi
done

echo "Cleaned $cleaned stale expired file(s)"
```

## 状态转换

| 当前状态 | 条件 | 执行动作 | 新状态 |
|----------|------|----------|--------|
| `active` | `now >= expiresAt` | 解散群组 | `expired` |
| `expired` | 超过保留期 | 删除文件 | *(删除)* |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `lark-cli` 不可用 | 发送通知到 chatId，终止执行 |
| `jq` 不可用 | 尝试用 `python3` 作为 fallback |
| 群组解散失败 | 记录警告，仍标记会话为 expired |
| Session 文件损坏 | 记录错误，跳过该文件 |
| 时间戳解析失败 | 记录警告，跳过清理 |
| 无超时会话 | 静默跳过，仅执行清理 |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用（只处理 active+expired 状态）
2. **无状态**: Schedule 不维护内存状态，所有状态从文件读取
3. **串行处理**: 一次处理一个会话，避免并发问题
4. **不创建新 Schedule**: 遵守定时任务执行环境规则
5. **不修改其他文件**: 仅操作 `workspace/temporary-sessions/` 目录

## 验收标准

- [ ] 能检测并处理超时的 active 会话
- [ ] 能通过 lark-cli 解散群组
- [ ] 解散失败时不影响状态更新
- [ ] 能清理超过保留期的 expired 文件
- [ ] 环境依赖缺失时能发送通知
