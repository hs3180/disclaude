---
name: "Chats Cleanup"
cron: "0 0 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-05T00:00:00.000Z
---

# Chats Cleanup

清理超过保留期的 `expired` 会话文件，释放磁盘空间并保持目录整洁。配合 `chat-timeout` skill 使用，构成完整的临时会话生命周期管理。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每小时
- **保留期**: 1 小时（`CHAT_CLEANUP_RETENTION` 环境变量可覆盖，单位：秒）
- **每次最多处理**: 50 个（`CHAT_MAX_PER_RUN` 环境变量可覆盖）

## 前置依赖

- `jq`（JSON 处理工具）
- `flock`（Linux 文件锁工具，util-linux 包提供 — **仅支持 Linux**）

> **⚠️ 平台要求**: 本 Schedule 依赖 `flock`，为 Linux 标准工具。

## 职责边界

- ✅ 删除超过保留期的 expired 会话文件
- ✅ 删除关联的 `.lock` 文件
- ❌ 不处理 active/pending/failed 会话
- ❌ 不标记会话为 expired（由 `chat-timeout` skill 负责）
- ❌ 不解散群组（由 `chat-timeout` skill 负责）

## 执行步骤

```bash
bash scripts/chat/cleanup.sh
```

### Step 1: 扫描 expired 会话

遍历 `workspace/chats/*.json`，查找所有 `status=expired` 的文件：
- 跳过损坏的 JSON 文件（`jq empty` 校验）
- 优先使用 `expiredAt` 时间戳，fallback 到 `expiresAt`
- 验证时间戳格式（UTC Z-suffix ISO 8601）
- 计算文件年龄，跳过未超过保留期的文件

### Step 2: 删除过期文件

对每个超过保留期的 expired 会话：
1. **获取排他锁** — `flock -n` 防止与其他进程冲突
2. **重新验证** — 在锁内再次确认 status 仍为 expired
3. **删除文件** — 删除 `.json` 文件和对应的 `.lock` 文件
4. **限流保护** — 每次执行最多处理 50 个

## 状态转换

| 当前状态 | 条件 | 执行动作 | 结果 |
|----------|------|----------|------|
| `expired` | 年龄 < 保留期 | 跳过 | 保持 expired |
| `expired` | 年龄 ≥ 保留期 | 删除文件 + lock | *(已删除)* |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `jq` 不可用 | 立即终止执行（exit 1） |
| 文件损坏 | 记录警告，跳过该文件 |
| 无法解析时间戳 | 记录警告，跳过该文件 |
| 锁不可用 | 跳过该文件（另一个进程可能在处理） |
| 锁内状态变更 | 跳过删除（文件可能已被恢复） |
| 并发处理同一文件 | `flock -n` 非阻塞锁，跳过 |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用
2. **有限处理**: 每次最多处理 50 个文件
3. **安全删除**: 仅删除 confirmed expired 且超过保留期的文件
4. **并发安全**: 使用 `flock` 文件锁
5. **保留期可配**: 通过 `CHAT_CLEANUP_RETENTION` 环境变量调整

## 验收标准

- [ ] 能检测并清理超过保留期的 expired 会话文件
- [ ] 能正确删除关联的 `.lock` 文件
- [ ] 不会误删 active/pending/failed 会话
- [ ] 文件损坏时不影响其他文件处理
- [ ] 并发安全（多个实例不会冲突）
- [ ] 保留期可通过环境变量配置
