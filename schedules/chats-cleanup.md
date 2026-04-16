---
name: "Chats Cleanup"
cron: "0 */10 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-16T00:00:00.000Z
---

# Chats Cleanup

清理 `workspace/chats/` 中孤立的 `.lock` 文件和 `.stale.*` 残留文件。当 `chat-timeout` 删除了过期的 `.json` 文件后，对应的 `.lock` 文件可能残留，本 Schedule 负责清理这些孤立文件。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每 10 分钟

## 前置依赖

- Node.js 20.12+（通过 `tsx` 运行 TypeScript）

> **⚠️ 平台要求**: 本 Schedule 使用 TypeScript 实现，通过 `tsx` 运行。无外部依赖。

## 职责边界

- ✅ 清理孤立 `.lock` 文件（对应 `.json` 已被删除）
- ✅ 清理 `.stale.*` 残留文件（锁竞争留下的临时文件）
- ✅ 保留活跃进程持有的 `.lock` 文件
- ❌ 不删除仍有关联 `.json` 的 `.lock` 文件
- ❌ 不处理过期会话（由 `chat-timeout` schedule 负责）
- ❌ 不激活 pending 群聊（由 `chats-activation` schedule 负责）

## 执行步骤

```bash
npx tsx skills/chat/chats-cleanup.ts
```

脚本完整实现了以下逻辑：

### Step 1: 扫描 .lock 文件

遍历 `workspace/chats/` 目录，查找所有 `.lock` 文件和 `.stale.*` 文件。

### Step 2: 清理孤立 .lock 文件

对每个 `.lock` 文件：
1. **查找关联文件** — 检查对应的 `.json` 文件是否仍存在
2. **JSON 存在** → 跳过（锁仍有效）
3. **JSON 不存在** → 检查锁持有进程是否存活
4. **进程存活** → 跳过（进程仍在使用）
5. **进程已死/内容无效** → 安全删除 `.lock` 文件

### Step 3: 清理 .stale.* 残留

删除所有 `.stale.*` 文件（锁竞争时 `lock.ts` 原子重命名留下的临时文件）。

## 清理逻辑

| 文件类型 | 关联 .json | 持有进程 | 操作 |
|----------|-----------|---------|------|
| `.lock` | 存在 | — | 跳过 |
| `.lock` | 不存在 | 存活 | 跳过 |
| `.lock` | 不存在 | 已死/无效 | 删除 |
| `.stale.*` | — | — | 删除 |

## 安全保障

- **进程感知**: 活跃进程持有的锁不会被删除
- **原子操作**: 与 `lock.ts` 的原子重命名机制兼容
- **无副作用**: 删除操作仅针对确认孤立的文件
- **幂等执行**: 重复运行安全无副作用
- **零外部依赖**: 仅使用 Node.js 内置模块

## 相关组件

| 组件 | 职责 |
|------|------|
| `chat` skill | 创建/管理聊天生命周期 |
| `chats-activation` schedule | 激活 pending 聊天 |
| `chat-timeout` schedule | 超时检测 + 群组解散 + 过期文件清理 |
| **本 Schedule** | 清理孤立的 `.lock` 文件 |

## 验收标准

- [ ] 能检测并删除孤立 `.lock` 文件（`.json` 已不存在）
- [ ] 不删除仍有关联 `.json` 的 `.lock` 文件
- [ ] 不删除活跃进程持有的 `.lock` 文件
- [ ] 能清理 `.stale.*` 残留文件
- [ ] 无孤立文件时正常退出
- [ ] 聊天目录不存在时正常退出
