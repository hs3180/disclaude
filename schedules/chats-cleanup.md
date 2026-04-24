---
name: "Chats Cleanup"
cron: "0 0 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-24T00:00:00.000Z
---

# Chats Cleanup

清理 `workspace/chats/` 目录中的孤儿 `.lock` 文件，防止锁文件泄漏。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每小时
- **锁文件最大存活时间**: 1 小时（`CHAT_LOCK_MAX_AGE_HOURS` 环境变量可覆盖）

## 前置依赖

- Node.js 18+（使用 PID-based 文件锁，无 `fs.flock` 依赖）

## 职责边界

- ✅ 清理孤儿 `.lock` 文件（对应 `.json` 文件已删除）
- ✅ 清理过期 `.lock` 文件（持有者进程已死亡且超过最大存活时间）
- ✅ 清理损坏 `.lock` 文件（内容格式无效）
- ❌ 不处理 `.json` 文件（由 `chat-timeout` schedule 负责）
- ❌ 不创建或解散群组（由 `chats-activation` 和 `chat-timeout` 负责）

## 执行步骤

```bash
npx tsx skills/chat/cleanup-locks.ts
```

### Step 1: 扫描锁文件

遍历 `workspace/chats/*.lock`，收集所有锁文件路径。

### Step 2: 检查每个锁文件

对每个 `.lock` 文件：

1. **检查对应文件是否存在** — 如果 `pr-123.json.lock` 对应的 `pr-123.json` 不存在，标记为孤儿锁
2. **检查锁内容** — 解析锁文件内容（格式: `PID\ntimestamp\n`），无效内容标记为损坏锁
3. **检查持有者进程** — 通过 `process.kill(pid, 0)` 检查进程是否存活
4. **检查锁年龄** — 如果锁文件创建时间超过最大存活时间（默认 1 小时），标记为过期

### Step 3: 清理符合条件的锁文件

删除满足以下任一条件的锁文件：
- 对应的 `.json` 文件不存在（孤儿锁）
- 锁内容无效（损坏锁）
- 持有者进程已死亡且超过最大存活时间（过期锁）

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 锁文件内容格式无效 | 视为损坏锁，直接删除 |
| 锁文件读取失败 | 跳过，记录警告 |
| 删除锁文件失败 | 跳过，记录警告 |
| Chat 目录不存在 | 正常退出（尚无聊天文件） |

## 注意事项

1. **保守策略**: 只删除明确可安全删除的锁文件（孤儿、损坏或过期）
2. **不删除活跃锁**: 如果持有者进程存活且锁年龄未超限，不删除
3. **幂等性**: 重复执行安全，无副作用
4. **低频执行**: 每小时执行一次即可，锁文件泄漏风险低
5. **与 lock.ts 协同**: lock.ts 的 `tryRemoveStaleLock()` 在锁获取时也会清理过期锁，本 Schedule 作为补充性的批量清理
