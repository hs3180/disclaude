---
name: "Chats Cleanup"
cron: "0 */5 * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-06T00:00:00.000Z
---

# Chats Cleanup

自动处理超时的临时群聊：解散过期群组、标记状态为 expired，并清理超过保留期的过期文件。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每 5 分钟
- **每次最多处理**: 10 个（`CHAT_MAX_PER_RUN` 环境变量可覆盖）
- **过期文件保留期**: 1 小时（`CHAT_RETENTION_HOURS` 环境变量可覆盖）

## 前置依赖

- `lark-cli`（飞书官方 CLI，npm 全局安装）
- `jq`（JSON 处理工具）
- Node.js（运行 TypeScript 脚本）

## 职责边界

- ✅ 检测超时的 active 群聊（`now >= expiresAt`）
- ✅ 解散群组（通过 `lark-cli`，仅无用户响应时）
- ✅ 更新状态为 `expired`
- ✅ 清理超过保留期的 `expired` 文件
- ❌ 不处理 pending 群聊（由 `chats-activation` schedule 负责）
- ❌ 不创建或激活群聊（由 `chats-activation` schedule 负责）
- ❌ 不发送消息到群组（由消费方 skill 负责）

## 执行步骤

### Phase 1: 超时检测与群组解散

```bash
CHAT_MAX_PER_RUN=10 bash scripts/chat-timeout/timeout.sh
```

脚本完整实现了以下逻辑：

#### Step 0: 环境检查（fail-fast）

检查 `lark-cli` 是否可用。**缺失则立即终止**（`exit 1`），不继续执行。

#### Step 1: 扫描 active 群聊

遍历 `workspace/chats/*.json`，查找所有 `status=active` 的文件：
- 跳过损坏的 JSON 文件
- 跳过非 UTC Z-suffix 格式的 `expiresAt`（fail-open）
- 跳过未过期的群聊（`expiresAt >= now`）

#### Step 2: 处理超时群聊

对每个超时的 active 群聊：

1. **检查用户响应** — 如果 `response` 字段有值，仅标记为 `expired`（不解散群组）
2. **解散群组** — 通过 `lark-cli api DELETE /open-apis/im/v1/chats/{chatId}` 解散
3. **更新状态** — `flock` 排他锁保护下，更新 `status` 为 `expired`，写入 `expiredAt`
4. **容错处理** — 群组解散失败仍然标记为 `expired`（群组可能已被手动删除）

### Phase 2: 过期文件清理

```bash
CHAT_RETENTION_HOURS=1 CHAT_MAX_PER_RUN=50 bash scripts/chat-timeout/cleanup.sh
```

#### Step 1: 扫描 expired 群聊

遍历 `workspace/chats/*.json`，查找所有 `status=expired` 的文件。

#### Step 2: 清理超过保留期的文件

对每个 expired 文件：
- 检查 `expiredAt` 是否超过保留期（默认 1 小时）
- 超过保留期 → 删除 `.json` 文件和 `.lock` 文件
- 未超过保留期 → 保留

## 状态转换

| 当前状态 | 条件 | 执行动作 | 新状态 |
|----------|------|----------|--------|
| `active` | `now >= expiresAt` 且无响应 | 解散群组 + 更新状态 | `expired` |
| `active` | `now >= expiresAt` 且有响应 | 仅更新状态 | `expired` |
| `expired` | `now - expiredAt > retention` | 删除文件 + lock | (已删除) |
| `expired` | `now - expiredAt <= retention` | 保留文件 | `expired` |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `lark-cli` 不可用 | 立即终止执行（exit 1） |
| 群组解散失败（API 错误） | 记录警告，仍然标记为 expired |
| 群组解散超时（> 30s） | 记录警告，仍然标记为 expired |
| Chat 文件损坏（非 JSON） | 记录警告，跳过该文件 |
| 文件删除失败（权限） | 记录错误，跳过该文件 |
| `expiredAt` 缺失或格式错误 | 跳过清理（fail-open） |
| 并发处理同一文件 | `flock` 非阻塞锁，跳过已被其他实例处理的文件 |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用（检测状态后操作）
2. **容错设计**: 群组解散失败不阻塞状态更新
3. **无状态**: Schedule 不维护内存状态，所有状态从文件读取
4. **串行处理**: 一次处理一个群聊，避免并发问题
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只处理 `workspace/chats/` 目录下的文件
7. **并发安全**: 使用 `flock` 文件锁防止多个 Schedule 实例同时处理同一文件
8. **超时保护**: `lark-cli` 调用设 30 秒超时，防止挂起阻塞后续处理
9. **限流保护**: 每次执行最多处理 10 个群聊（`CHAT_MAX_PER_RUN`），防止 API 限流
10. **保留期保护**: 过期文件保留 1 小时，给消费方足够时间读取最终状态
11. **Dry-run 支持**: `CHAT_DRY_RUN=true` 可预览操作而不实际执行

## 验收标准

- [ ] 能检测并处理超时的 active 群聊
- [ ] 能正确解散群组（通过 lark-cli）
- [ ] 有用户响应的群聊不解散，仅标记过期
- [ ] 群组解散失败不影响状态更新
- [ ] 过期文件超过保留期后被清理
- [ ] 环境依赖缺失时立即终止执行
- [ ] 每次执行最多处理 10 个群聊，不会 API 限流
