---
name: "Chats Cleanup"
cron: "0 */30 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-08T00:00:00.000Z
---

# Chats Cleanup

清理 `workspace/chats/` 目录中的孤儿 `.lock` 文件和过期的 `failed` 状态会话文件。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每 30 分钟
- **Failed 文件保留期**: 24 小时（`CHAT_FAILED_RETENTION_HOURS` 环境变量可覆盖）
- **Lock 文件最大年龄**: 60 秒（`CHAT_LOCK_MAX_AGE_MS` 环境变量可覆盖，仅用于无 `fs.flock` 支持时）

## 前置依赖

- `@larksuite/cli`（飞书官方 CLI，npm 全局安装）
- Node.js 20.12+（用于 `fs.flock` 文件锁检测，低版本自动降级为基于年龄的启发式判断）

> **⚠️ 平台要求**: 本 Schedule 使用 TypeScript 实现，通过 `tsx` 运行。孤儿 lock 检测依赖 Node.js 20.12+ 的 `fs.flock`，低版本自动降级为基于文件修改时间的启发式判断。

## 职责边界

- ✅ 清理孤儿 `.lock` 文件（未被任何进程持有的锁文件）
- ✅ 清理超过保留期的 `failed` 状态会话文件
- ✅ 清理 `failed` 文件关联的 `.lock` 文件
- ❌ 不处理 `pending`、`active`、`expired` 状态的会话文件（由 `chats-activation` 和 `chat-timeout` 负责）
- ❌ 不发送消息到群组（由消费方 skill 负责）
- ❌ 不创建或解散群组

## 执行步骤

```bash
npx tsx scripts/schedule/chats-cleanup.ts
```

脚本完整实现了以下逻辑：

### Step 0: 环境检查（fail-fast）

检查 `lark-cli` 是否可用。**缺失则立即终止**（`exit 1`），不继续执行。

### Step 1: 清理孤儿 .lock 文件

遍历 `workspace/chats/*.lock`，对每个 `.lock` 文件：

1. **路径验证** — `realpath` 检查，防止符号链接逃逸
2. **孤儿检测** — 尝试非阻塞独占锁（`fs.flock ifPresent`）：
   - **可获取** → 无进程持有 → 孤儿文件 → 删除
   - **不可获取** → 有进程正在使用 → 跳过
3. **降级策略** — 无 `fs.flock` 支持时，使用文件修改时间判断（超过 `CHAT_LOCK_MAX_AGE_MS` 视为孤儿）

### Step 2: 清理过期的 failed 文件

遍历 `workspace/chats/*.json`，查找 `status=failed` 的文件：

1. **读取并校验** — JSON 格式验证
2. **保留期检查** — `failedAt`（或 `createdAt` 兜底）超过保留期（默认 24 小时）
3. **删除文件** — 同时尝试删除关联的 `.lock` 文件

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `lark-cli` 不可用 | 立即终止执行（exit 1） |
| `.lock` 文件被其他进程持有 | 跳过（不删除活跃锁） |
| `.lock` 文件在扫描后被删除 | 跳过（文件不存在） |
| Chat 文件损坏（非 JSON） | 记录警告，跳过该文件 |
| `failed` 文件时间戳格式无效 | 记录警告，跳过清理 |
| `fs.flock` 不可用 | 降级为基于文件年龄的启发式判断 |

## 注意事项

1. **安全性**: 孤儿检测使用 `fs.flock` 非阻塞锁，确保不会删除活跃锁文件
2. **幂等性**: 重复执行不会产生副作用
3. **无状态**: Schedule 不维护内存状态，所有状态从文件系统读取
4. **保守策略**: `failed` 文件保留 24 小时（远长于 `expired` 的 1 小时），便于调试和问题排查
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只处理 `workspace/chats/` 目录下的文件
7. **优雅降级**: 无 `fs.flock` 时使用文件修改时间启发式判断，可接受因并发风险低
8. **关联清理**: 删除 `failed` 文件时同时清理关联的 `.lock` 文件

## 验收标准

- [ ] 能检测并清理孤儿 `.lock` 文件
- [ ] 不会删除被活跃进程持有的 `.lock` 文件
- [ ] 能清理超过保留期的 `failed` 状态文件
- [ ] 删除 `failed` 文件时同时清理关联的 `.lock` 文件
- [ ] 跳过损坏的 JSON 文件
- [ ] 环境依赖缺失时立即终止执行
- [ ] 在无 `fs.flock` 支持时正确降级
