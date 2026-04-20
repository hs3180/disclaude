---
name: "Chat Timeout"
cron: "0 */5 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-06T00:00:00.000Z
---

# Chat Timeout

自动检测超时的 active 临时群聊，解散群组（无响应时），更新状态为 expired，并清理过期的会话文件。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每 5 分钟
- **每次最多处理**: 10 个（`CHAT_MAX_PER_RUN` 环境变量可覆盖）
- **过期文件保留期**: 1 小时（`CHAT_EXPIRED_RETENTION_HOURS` 环境变量可覆盖）

## 前置依赖

- `@larksuite/cli`（飞书官方 CLI，npm 全局安装）
- Node.js 20.12+（用于 `fs.flock` 文件锁，低版本自动降级为无锁模式）

> **⚠️ 平台要求**: 本 Schedule 使用 TypeScript 实现，通过 `tsx` 运行。文件锁使用 PID-based 原子锁文件（`lock.ts`），无需 `fs.flock` 支持。

## 职责边界

- ✅ 检测超时的 active 会话
- ✅ 解散群组（仅限无用户响应的情况）
- ✅ 更新状态（active → expired）
- ✅ 清理超过保留期的 expired 文件
- ❌ 不发送消息到群组（由消费方 skill 负责）
- ❌ 不处理 pending 群聊（由 `chats-activation` schedule 负责）
- ❌ 不创建新群聊（由 `chats-activation` schedule 负责）

## 执行步骤

```bash
npx tsx skills/chat-timeout/chat-timeout.ts
```

脚本完整实现了以下逻辑：

### Step 0: 环境检查（fail-fast）

检查 `lark-cli` 是否可用。**缺失则立即终止**（`exit 1`），不继续执行。

### Step 1: 筛选过期会话

遍历 `workspace/chats/*.json`，查找两类目标：
- **过期 active 会话**: `status=active` 且 `expiresAt < now`（UTC Z-suffix 格式）
- **待清理 expired 文件**: `status=expired` 且 `expiredAt` 超过保留期

### Step 2: 处理过期会话

对每个过期 active 会话：

1. **读取数据** — 从 JSON 文件提取 `id`、`chatId`、`response`
2. **并发保护** — `fs.flock` 排他锁，防止多个 Schedule 实例同时处理同一文件
3. **二次校验** — 在锁内重新读取文件，确认状态仍为 active 且已过期
4. **群组解散** — 若无用户响应（`response` 为 null），通过 `lark-cli api DELETE` 解散群组；若有响应则跳过解散
5. **状态更新** — 将 `status` 更新为 `expired`，记录 `expiredAt` 时间戳
6. **限流保护** — 每次执行最多处理 10 个（可通过 `CHAT_MAX_PER_RUN` 环境变量覆盖）

### Step 3: 清理过期文件

对超过保留期的 expired 文件：
1. 二次确认状态仍为 expired
2. 删除文件

## 状态转换

| 当前状态 | 条件 | 执行动作 | 新状态 |
|----------|------|----------|--------|
| `active` | `expiresAt` 已过期 且 无用户响应 | 解散群组 + 更新状态 | `expired` |
| `active` | `expiresAt` 已过期 且 有用户响应 | 仅更新状态（不解散） | `expired` |
| `expired` | 超过保留期（默认 1 小时） | 删除文件 | （文件移除） |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `lark-cli` 不可用 | 立即终止执行（exit 1） |
| 群组解散失败 | 记录警告，继续标记为 expired（群组可能已被手动解散） |
| Chat 文件损坏（非 JSON） | 记录警告，跳过该文件 |
| 并发处理同一文件 | `fs.flock` 排他锁（Node 20.12+），跳过已被其他实例处理的文件 |
| 解散 API 超时（> 30s） | 视为解散失败，记录超时错误，继续标记为 expired |
| 清理时状态已变更 | 跳过清理（文件可能已被其他进程处理） |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用（锁内二次校验状态）
2. **有限处理**: 每次执行最多处理 10 个会话（`CHAT_MAX_PER_RUN`），防止 API 限流
3. **无状态**: Schedule 不维护内存状态，所有状态从文件读取
4. **串行处理**: 一次处理一个会话，避免并发问题
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只处理 `workspace/chats/` 目录下的文件
7. **并发安全**: 使用 PID-based 原子锁文件（`lock.ts`）防止多个 Schedule 实例同时处理同一文件
8. **超时保护**: `lark-cli` 调用设 30 秒超时（`child_process.timeout`），防止挂起阻塞后续 Schedule
9. **响应感知**: 有用户响应的会话不解散群组，保留结果供消费方读取
10. **优雅降级**: 群组解散失败不影响状态更新，避免因 API 暂时不可用导致无限重试
11. **延迟清理**: expired 文件保留 1 小时后清理，给消费方足够时间读取结果

## 验收标准

- [ ] 能检测并处理超时的 active 会话
- [ ] 无响应时会解散群组（通过 lark-cli）
- [ ] 有响应时不会解散群组
- [ ] 能正确更新状态为 expired
- [ ] 能清理超过保留期的 expired 文件
- [ ] 群组解散失败时不影响状态更新
- [ ] 并发安全（fs.flock 保护）
- [ ] 每次执行最多处理 10 个会话，不会 API 限流
