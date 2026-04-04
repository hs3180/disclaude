---
name: "Chats Cleanup"
cron: "0 0 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-05T00:00:00.000Z
---

# Chats Cleanup

定期清理已结束的临时群聊文件和孤立的锁文件，释放磁盘空间。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每小时
- **保留期限**: 7 天（`CHAT_CLEANUP_RETENTION_DAYS` 环境变量可覆盖）

## 前置依赖

- `jq`（JSON 处理工具）

## 职责边界

- ✅ 清理过期的 `expired` 和 `failed` 状态文件（超过保留期限）
- ✅ 清理孤立的 `.lock` 文件（无对应 `.json` 文件）
- ❌ 不处理 `pending` 或 `active` 状态的文件
- ❌ 不解散群组（由 `chat-timeout` skill 负责）
- ❌ 不创建或修改 chat 文件

## 执行步骤

```bash
bash scripts/schedule/chats-cleanup.sh
```

脚本完整实现了以下逻辑：

### Step 0: 环境检查（fail-fast）

检查 `jq` 是否可用。**缺失则立即终止**（`exit 1`）。

### Step 1: 清理过期/失败的 chat 文件

遍历 `workspace/chats/*.json`，查找所有 `status=expired` 或 `status=failed` 的文件：

1. **校验 JSON 完整性** — 跳过损坏的文件
2. **计算文件年龄** — 基于 `failedAt`（failed）或 `expiredAt`（expired）字段
3. **超过保留期限** — 删除 `.json` 文件和对应的 `.lock` 文件（如存在）

### Step 2: 清理孤立的 `.lock` 文件

遍历 `workspace/chats/*.lock`，检查是否有对应的 `.json` 文件：
- 无对应 `.json` → 删除孤立 `.lock` 文件

## 状态转换

本 Schedule 不改变任何 chat 的状态，仅删除文件。

| 条件 | 执行动作 |
|------|----------|
| `expired` 或 `failed` 且超过保留期限 | 删除 `.json` + `.lock` 文件 |
| 孤立 `.lock` 文件 | 删除 `.lock` 文件 |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `jq` 不可用 | 立即终止执行（exit 1） |
| Chat 文件损坏（非 JSON） | 记录警告，跳过该文件 |
| 文件删除失败 | 记录警告，继续处理其他文件 |
| `workspace/chats/` 目录不存在 | 正常退出（无文件需清理） |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用（已删除的文件不会报错）
2. **保留期限**: 默认 7 天，可通过 `CHAT_CLEANUP_RETENTION_DAYS` 环境变量覆盖
3. **无状态**: Schedule 不维护内存状态，所有数据从文件读取
4. **不创建新 Schedule**: 这是定时任务执行环境的规则
5. **不修改其他文件**: 只处理 `workspace/chats/` 目录下的文件
6. **安全删除**: 只删除 `expired` 和 `failed` 状态的文件，不触碰 `pending` 和 `active`

## 验收标准

- [ ] 能清理超过保留期限的 expired chat 文件
- [ ] 能清理超过保留期限的 failed chat 文件
- [ ] 能清理孤立的 .lock 文件
- [ ] 不清理 pending 或 active 状态的文件
- [ ] 环境依赖缺失时立即终止执行
- [ ] 目录不存在时正常退出
