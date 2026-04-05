---
name: "Chats Cleanup"
cron: "0 0 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-05T00:00:00.000Z
---

# Chats Cleanup

自动清理超过保留期的 expired 会话文件及其 lock 文件，释放磁盘空间。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每小时
- **默认保留期**: 1 小时（`CHAT_RETENTION_HOURS` 环境变量可覆盖）
- **每次最多清理**: 50 个（`CHAT_MAX_PER_RUN` 环境变量可覆盖）

## 前置依赖

- `jq`（JSON 处理工具）
- `flock`（Linux 文件锁工具，util-linux 包提供 — **仅支持 Linux**）

## 职责边界

- ✅ 清理超过保留期的 `expired` 和 `failed` 会话文件
- ✅ 清理孤立的 `.lock` 文件
- ❌ 不处理 `active` 或 `pending` 会话（由 `chats-activation` 和 `chat-timeout` 负责）
- ❌ 不解散群组（由 `chat-timeout` skill 负责）
- ❌ 不修改会话状态

## 执行步骤

```bash
bash scripts/schedule/chats-cleanup.sh
```

### Step 1: 环境检查

检查 `jq`、`flock` 是否可用。缺失则立即终止。

### Step 2: 扫描 expired/failed 会话

遍历 `workspace/chats/*.json`，查找 `status=expired` 或 `status=failed` 的文件。

### Step 3: 检查保留期

对每个候选文件：
- 读取 `expiredAt` 或 `failedAt` 时间戳
- 与当前时间比较，超过保留期则标记为待删除
- 无时间戳的文件使用文件修改时间（`mtime`）

### Step 4: 清理文件

对每个待删除文件：
1. 获取排他锁
2. 再次确认状态未变更
3. 删除 `.json` 文件和对应的 `.lock` 文件

### Step 5: 清理孤立 lock 文件

扫描 `.lock` 文件，如果对应的 `.json` 文件不存在，删除孤立 lock 文件。

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `jq`/`flock` 不可用 | 立即终止执行 |
| 文件被锁定 | 跳过该文件 |
| 状态已变更 | 跳过该文件 |
| 删除失败 | 记录警告，继续处理下一个 |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用
2. **保守删除**: 只删除 `expired`/`failed` 状态的文件
3. **保留期保护**: 不会立即删除刚过期的文件，给消费方足够时间轮询结果
4. **串行处理**: 一次处理一个文件，避免并发问题
