---
name: "Chats Cleanup"
cron: "0 0 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-04T00:00:00.000Z
---

# Chats Cleanup

定期清理过期的临时群聊文件和孤立的锁文件，保持 `workspace/chats/` 目录整洁。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每小时
- **清理阈值**: 过期/失败后保留 24 小时（`CHAT_CLEANUP_GRACE_HOURS` 环境变量可覆盖）
- **每次最多清理**: 50 个（`CHAT_CLEANUP_MAX_PER_RUN` 环境变量可覆盖）

## 前置依赖

- `jq`（JSON 处理工具）
- `flock`（Linux 文件锁工具，util-linux 包提供 — **仅支持 Linux**）

> **⚠️ 平台要求**: 本 Schedule 依赖 `flock`，为 Linux 标准工具。如需在 macOS 运行，需替换为 `shlock` 或 `lockfile`。

## 职责边界

- ✅ 清理过期的 expired/failed 聊天文件（超过保留期）
- ✅ 清理孤立的 `.lock` 文件（无对应 JSON 文件）
- ✅ 清理已激活聊天（active）的孤立锁文件
- ❌ 不修改活跃聊天的状态（active 状态不触碰）
- ❌ 不创建/解散群组（由 `chats-activation` 和 `chat-timeout` 负责）
- ❌ 不发送消息（由消费方 skill 负责）

## 执行步骤

```bash
bash scripts/schedule/chats-cleanup.sh
```

脚本完整实现了以下逻辑：

### Step 0: 环境检查（fail-fast）

检查 `jq`、`flock` 是否可用。**任一缺失则立即终止**（`exit 1`），不继续执行。

### Step 1: 清理过期的 expired/failed 聊天文件

遍历 `workspace/chats/*.json`，查找所有 `status=expired` 或 `status=failed` 的文件：

1. 检查 `expiredAt` 或 `failedAt` 时间戳
2. 与当前时间比较，超过保留阈值（默认 24 小时）则删除
3. 同时删除对应的 `.lock` 文件（如果存在）
4. 使用 `flock` 保护，避免与正在运行的 Schedule 冲突

### Step 2: 清理孤立的 .lock 文件

遍历 `workspace/chats/*.lock`，查找没有对应 `.json` 文件的锁文件：

1. 检查锁文件对应的 `.json` 文件是否存在
2. 不存在则说明是孤立锁文件（可能是之前崩溃遗留）
3. 安全删除孤立锁文件

## 状态处理

| 聊天状态 | 处理方式 |
|----------|----------|
| `pending` | ❌ 不处理（由 `chats-activation` 管理） |
| `active` | ❌ 不处理（由 `chat-timeout` 管理） |
| `expired` | ✅ 超过保留期后删除文件 + 锁 |
| `failed` | ✅ 超过保留期后删除文件 + 锁 |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `jq`/`flock` 不可用 | 立即终止执行（exit 1） |
| Chat 文件损坏（非 JSON） | 记录警告，跳过该文件 |
| 时间戳格式异常 | 记录警告，跳过该文件（fail-open） |
| 文件删除失败 | 记录警告，继续处理下一个 |
| 并发处理同一文件 | `flock` 保护，跳过已被锁定的文件 |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用
2. **保守策略**: 只清理 expired/failed 状态的文件，不触碰 pending/active
3. **保留期设计**: 默认 24 小时保留期，给消费方足够时间读取最终状态
4. **无状态**: Schedule 不维护内存状态，所有状态从文件读取
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只处理 `workspace/chats/` 目录下的文件
7. **锁文件清理**: 防止孤立锁文件长期占用（崩溃恢复场景）

## 验收标准

- [ ] 能检测并清理超期的 expired 聊天文件
- [ ] 能检测并清理超期的 failed 聊天文件
- [ ] 能清理孤立的 .lock 文件
- [ ] 不触碰 pending/active 状态的聊天文件
- [ ] 环境依赖缺失时立即终止执行
- [ ] 文件损坏时安全跳过，不影响其他文件
