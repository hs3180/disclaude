---
name: "Chats Cleanup"
cron: "0 */5 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-17T00:00:00.000Z
---

# Chats Cleanup

自动清理 `workspace/chats/` 中的孤儿 `.lock` 文件和 `.stale.*` 残留文件。这些文件在进程崩溃（OOM、SIGKILL 等）未能正常释放锁时积累。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每 5 分钟
- **每次最多清理**: 50 个文件（`CHAT_MAX_CLEANUP` 环境变量可覆盖）

## 前置依赖

- Node.js（用于 `tsx` 运行 TypeScript 脚本）

> **⚠️ 无外部依赖**: 本 Schedule 不需要 `lark-cli`，仅扫描和删除文件系统中的残留锁文件。

## 职责边界

- ✅ 清理孤儿 `.lock` 文件（holder 进程已死亡）
- ✅ 清理损坏的 `.lock` 文件（内容无效）
- ✅ 清理 `.stale.*` 残留文件（来自 lock.ts rename 竞争）
- ❌ 不处理 JSON chat 文件（由 `chat-timeout` skill 负责）
- ❌ 不处理 active 状态的锁（holder 进程仍在运行）
- ❌ 不创建或解散群组

## 执行步骤

```bash
npx tsx schedules/chats-cleanup.ts
```

脚本完整实现了以下逻辑：

### Step 1: 扫描 .lock 文件

遍历 `workspace/chats/*.lock`，对每个 lock 文件：
1. **读取内容** — 解析 PID + 时间戳（格式：`PID\ntimestamp\n`）
2. **检测进程** — 通过 `process.kill(pid, 0)` 检查 holder 进程是否存活
3. **清理规则**:
   - 内容损坏（无法解析） → 删除
   - Holder 进程已死亡 → 删除
   - Holder 进程仍存活 → 跳过

### Step 2: 清理 .stale.* 文件

遍历 `workspace/chats/*.stale.{pid}` 文件，这些是 `lock.ts` 中 `tryRemoveStaleLock` 在 rename 竞争中可能遗留的中间文件，直接删除即可。

## 清理规则

| 文件类型 | 条件 | 执行动作 |
|----------|------|----------|
| `.lock` | 内容损坏/无效 | 删除 |
| `.lock` | Holder 进程已死亡 | 删除 |
| `.lock` | Holder 进程存活 | 跳过 |
| `.stale.*` | 存在即清理 | 删除 |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| Chat 目录不存在 | 正常退出（INFO） |
| Lock 文件已被其他进程删除 | 静默跳过 |
| 权限不足无法删除 | 静默跳过（记录错误） |
| 文件读取失败 | 静默跳过 |

## 注意事项

1. **无副作用**: 只删除残留文件，不影响正常的锁操作
2. **安全检测**: 只删除 holder 进程已确认死亡的锁
3. **限流保护**: 每次最多清理 50 个文件（`CHAT_MAX_CLEANUP`）
4. **无需 lark-cli**: 纯文件系统操作，无外部依赖
5. **与 lock.ts 互补**: lock.ts 在 acquireLock 时内联清理过期锁，本 Schedule 处理那些从未被再次获取的孤儿锁

## 验收标准

- [ ] 能检测并清理 holder 进程已死亡的 .lock 文件
- [ ] 能清理内容损坏的 .lock 文件
- [ ] 不清理 holder 进程仍存活的 .lock 文件
- [ ] 能清理 .stale.* 残留文件
- [ ] 每次执行最多清理指定数量的文件
- [ ] 无 lark-cli 依赖，纯文件系统操作
