---
name: "Chats Cleanup"
cron: "0 0 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-21T00:00:00.000Z
---

# Chats Cleanup

清理 `workspace/chats/` 目录下的孤儿 `.lock` 文件和残留的 `.stale.*` 临时文件。

当 `chat-timeout` Schedule 清理过期会话文件（删除 `.json`）后，对应的 `.lock` 文件会残留成为孤儿文件。此外，`lock.ts` 在处理锁竞争时可能留下 `.stale.*` 临时文件。本 Schedule 定期清理这些文件。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每小时
- **无需外部依赖**: 不依赖 `lark-cli`（纯文件操作）

## 职责边界

- ✅ 清理孤儿 `.lock` 文件（无对应 `.json` 文件的锁文件）
- ✅ 清理残留的 `.stale.*` 临时文件（锁竞争重命名的残留）
- ✅ 清理残留的 `.*.tmp` 临时文件（原子写入的残留）
- ❌ 不删除 `.json` 文件（由 `chat-timeout` Schedule 负责）
- ❌ 不处理 pending/active 状态的会话（由 `chats-activation` 和 `chat-timeout` 负责）

## 执行步骤

```bash
npx tsx schedules/chats-cleanup.ts
```

### Step 1: 扫描可清理文件

遍历 `workspace/chats/` 目录，收集三类文件：
- `*.json.lock` — 孤儿锁文件（无对应 `.json`）
- `*.stale.*` — 锁竞争残留（来自 `lock.ts` 的原子重命名）
- `.*.tmp` — 原子写入残留（来自 `atomicWrite` 的临时文件）

### Step 2: 验证并清理

对每个候选文件：
1. **孤儿锁文件**: 检查对应的 `.json` 文件是否存在，不存在则删除
2. **`.stale.*` 文件**: 直接删除（这些是锁竞争的临时产物）
3. **`.*.tmp` 文件**: 直接删除（这些是原子写入失败的残留）

### Step 3: 输出报告

报告清理结果（清理数量、跳过数量）。

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| Chat 目录不存在 | 正常退出（无需清理） |
| 文件删除失败 | 记录警告，继续处理其他文件 |
| 权限不足 | 记录错误，跳过该文件 |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用
2. **无状态**: 不维护内存状态
3. **轻量级**: 纯文件操作，无外部依赖
4. **安全**: 只删除 `.lock`、`.stale.*`、`.*.tmp` 文件，不碰 `.json` 文件
5. **路径验证**: 确保所有操作在 `workspace/chats/` 目录内（防止路径遍历）

## 验收标准

- [ ] 能检测并清理孤儿 `.lock` 文件
- [ ] 能清理残留的 `.stale.*` 临时文件
- [ ] 能清理残留的 `.*.tmp` 临时文件
- [ ] 不会删除 `.json` 文件
- [ ] 有对应 `.json` 的 `.lock` 文件不会被误删
- [ ] Chat 目录不存在时正常退出
- [ ] 并发安全（不干扰正在使用的锁文件）
