---
name: "Chats Cleanup"
cron: "0 0 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-21T00:00:00.000Z
---

# Chats Cleanup

Clean up orphaned `.lock` files, leftover `.tmp` files, and `.stale.*` files in `workspace/chats/`. These files are normally cleaned up by their creators, but crashes or process kills can leave them behind.

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每 1 小时
- **最小文件年龄**: 1 分钟（`CHAT_LOCK_MIN_AGE_MS` 环境变量可覆盖）
- **每次最多清理**: 50 个（`CHAT_MAX_CLEANUP` 环境变量可覆盖）

## 职责边界

- ✅ 清理孤立的 `.lock` 文件（持有者进程已死亡）
- ✅ 清理过期的 `.tmp` 文件（来自中断的原子写入）
- ✅ 清理残留的 `.stale.*` 文件（来自 lock.ts 原子重命名操作）
- ❌ 不处理 JSON 聊天文件（由 `chat-timeout` schedule 负责）
- ❌ 不创建或解散群组
- ❌ 不发送消息

## 执行步骤

```bash
npx tsx schedules/chats-cleanup.ts
```

脚本完整实现了以下逻辑：

### Step 1: 环境配置

解析环境变量 `CHAT_LOCK_MIN_AGE_MS` 和 `CHAT_MAX_CLEANUP`，应用默认值。

### Step 2: 扫描 .lock 文件

遍历 `workspace/chats/*.lock`，对每个锁文件：

1. **读取内容** — 解析 `PID\ntimestamp\n` 格式
2. **有效性检查** — 内容损坏的锁文件在满足年龄条件后删除
3. **进程存活检查** — 通过 `process.kill(pid, 0)` 检查持有者进程
4. **年龄检查** — 锁文件必须超过最小年龄（默认 1 分钟），避免竞态条件
5. **安全删除** — 确认孤立后删除文件

### Step 3: 清理 .tmp 文件

遍历 `workspace/chats/*.tmp`，对每个临时文件：

1. **年龄检查** — 文件必须超过最小年龄
2. **安全删除** — 确认过期后删除

### Step 4: 清理 .stale.* 文件

遍历匹配 `*.stale.{pid}` 模式的文件，直接删除（这些是 lock.ts 原子重命名操作的残留）。

## 清理条件

| 文件类型 | 条件 | 处理方式 |
|----------|------|----------|
| `.lock` | 内容损坏 + 年龄 > 阈值 | 删除 |
| `.lock` | 持有者进程已死亡 + 年龄 > 阈值 | 删除 |
| `.lock` | 持有者进程存活 | 保留 |
| `.tmp` | 年龄 > 阈值 | 删除 |
| `.stale.*` | 存在即清理 | 删除 |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| Chat 目录不存在 | 正常退出（无内容需清理） |
| 单个文件清理失败 | 记录警告，继续处理其他文件 |
| 环境变量格式错误 | 使用默认值并记录警告 |

## 注意事项

1. **安全优先**: 新创建的文件（< 1 分钟）不会被清理，避免竞态条件
2. **有限处理**: 每次最多清理 50 个文件，防止意外大量删除
3. **无外部依赖**: 不需要 `lark-cli` 或网络访问
4. **幂等性**: 重复执行安全，已删除的文件会跳过
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只处理 `workspace/chats/` 目录下的 `.lock`、`.tmp`、`.stale.*` 文件

## 验收标准

- [ ] 能清理持有者进程已死亡的孤立 `.lock` 文件
- [ ] 能清理内容损坏的 `.lock` 文件
- [ ] 不会清理持有者进程仍存活的 `.lock` 文件
- [ ] 不会清理年龄小于阈值的文件（避免竞态）
- [ ] 能清理过期的 `.tmp` 文件
- [ ] 能清理残留的 `.stale.*` 文件
- [ ] 目录不存在时正常退出
- [ ] 单文件失败不影响其他文件清理
