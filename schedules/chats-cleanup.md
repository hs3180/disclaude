---
name: "Chats Cleanup"
cron: "0 */10 * * * *"
enabled: true
blocking: false
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-06T00:00:00.000Z
---

# Chats Cleanup

清理 `workspace/chats/` 目录中的孤立 `.lock` 文件。当 `chat-timeout` 脚本删除过期的会话文件时，对应的 `.lock` 文件会被遗留。此 Schedule 定期扫描并清理这些孤立文件。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每 10 分钟
- **锁文件最大年龄**: 1 小时（`CHAT_LOCK_MAX_AGE_HOURS` 环境变量可覆盖）
  - 只清理超过此年龄的孤立 `.lock` 文件，避免误删正在使用的锁文件

## 前置依赖

- Node.js 20.12+

## 职责边界

- ✅ 清理孤立的 `.lock` 文件（对应的 `.json` 文件已不存在）
- ✅ 年龄检查（跳过近期创建的 `.lock` 文件）
- ❌ 不删除 `.json` 文件（由 `chat-timeout` skill 负责）
- ❌ 不处理会话状态转换（由 `chats-activation` 和 `chat-timeout` 负责）
- ❌ 不创建或解散群组

## 执行步骤

```bash
npx tsx scripts/schedule/chats-cleanup.ts
```

脚本完整实现了以下逻辑：

### Step 1: 扫描 .lock 文件

遍历 `workspace/chats/` 目录，查找所有 `.lock` 文件。

### Step 2: 识别孤立文件

对每个 `.lock` 文件：
1. **年龄检查** — 如果文件修改时间在 `CHAT_LOCK_MAX_AGE_HOURS` 以内，跳过
2. **对应文件检查** — 检查对应的 `.json` 文件是否存在
3. **清理** — 如果 `.json` 文件不存在，删除孤立的 `.lock` 文件

## 安全保障

- **年龄阈值**: 只清理超过 1 小时的 `.lock` 文件，避免误删活跃锁
- **路径验证**: 确保所有文件操作在 `workspace/chats/` 目录内
- **幂等性**: 重复执行不会产生副作用
- **非阻塞**: `blocking: false`，不影响其他 Schedule 执行

## 注意事项

1. **幂等性**: 重复执行安全（不存在则跳过）
2. **无状态**: Schedule 不维护内存状态
3. **非阻塞**: 不阻塞其他 Schedule（`blocking: false`）
4. **低频率**: 每 10 分钟执行一次即可（`.lock` 文件清理不紧急）
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只处理 `workspace/chats/` 目录下的 `.lock` 文件

## 验收标准

- [ ] 能检测并清理孤立的 `.lock` 文件
- [ ] 不会删除近期创建的 `.lock` 文件
- [ ] 对应 `.json` 文件存在时不会删除 `.lock` 文件
- [ ] 执行幂等（重复执行安全）
