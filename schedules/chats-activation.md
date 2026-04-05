---
name: "Chats Activation"
cron: "0 * * * * *"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: 2026-04-03T00:00:00.000Z
---

# Chats Activation

自动激活 pending 状态的临时群聊：通过 `lark-cli` 创建群组，更新状态为 active。对反复失败的群聊自动标记为 failed，避免无限重试。

## 配置

- **Chat 目录**: `workspace/chats/`
- **执行间隔**: 每 1 分钟
- **每次最多处理**: 10 个（`CHAT_MAX_PER_RUN` 环境变量可覆盖）

## 前置依赖

- `@larksuite/cli`（飞书官方 CLI，npm 全局安装）
- `jq`（JSON 处理工具）
- `flock`（Linux 文件锁工具，util-linux 包提供 — **仅支持 Linux**）
- `timeout`（GNU coreutils 超时命令 — **仅支持 Linux**，macOS 需 `brew install coreutils` 后使用 `gtimeout`）

> **⚠️ 平台要求**: 本 Schedule 依赖 `flock` 和 `timeout`，均为 Linux 标准工具。如需在 macOS 运行，需安装 GNU coreutils 并替换 `timeout` 为 `gtimeout`、`flock` 为 `shlock` 或 `lockfile`。

## 职责边界

- ✅ 创建群组（通过 `lark-cli`）
- ✅ 更新状态（pending → active）
- ✅ 标记失败（达到重试上限后 → failed）
- ✅ 标记过期（`expiresAt` 已过期的 pending 群聊 → expired）
- ❌ 不发送消息到群组（由消费方 skill 负责）
- ❌ 不处理超时/解散群组（由 `discussion-end` skill 负责）
- ❌ 不清理文件（由 `chats-cleanup` schedule 负责）

## 执行步骤

```bash
bash scripts/schedule/chats-activation.sh
```

脚本完整实现了以下逻辑：

### Step 0: 环境检查（fail-fast）

检查 `lark-cli`、`jq`、`flock`、`timeout` 是否可用。**任一缺失则立即终止**（`exit 1`），不继续执行。

### Step 1: 列出 pending 群聊

遍历 `workspace/chats/*.json`，查找所有 `status=pending` 的文件：
- 跳过损坏的 JSON 文件（`jq empty` 校验）
- **过期预检**: 如果 `expiresAt` 已过期（UTC Z-suffix 格式），直接标记为 `expired`，跳过激活
- 非 UTC 格式的 `expiresAt` 跳过过期检查（fail-open）

### Step 2: 激活 pending 群聊

对每个 pending 群聊：

1. **读取数据** — 从 JSON 文件提取 `id`、`createGroup.name`、`createGroup.members`、`activationAttempts`
2. **输入校验** — `group_name` 白名单校验 + UTF-8 字符级截断、`members` `ou_xxxxx` 格式校验
3. **并发保护** — `flock -n` 排他锁，防止多个 Schedule 实例同时处理同一文件
4. **幂等恢复** — 检测已有 `chatId`，自动恢复为 `active`（Schedule 崩溃恢复场景）
5. **创建群组** — 通过 `lark-cli im +chat-create` 创建，30 秒超时保护
6. **处理结果** — 成功则更新为 `active`，失败则记录错误并在达到 5 次上限后标记为 `failed`
7. **限流保护** — 每次执行最多处理 10 个（可通过 `CHAT_MAX_PER_RUN` 环境变量覆盖）

## 状态转换

| 当前状态 | 条件 | 执行动作 | 新状态 |
|----------|------|----------|--------|
| `pending` | chatId 已存在 | 恢复状态（幂等） | `active` |
| `pending` | `expiresAt` 已过期（UTC Z-suffix） | 标记为 expired，跳过激活 | `expired` |
| `pending` | 群组创建成功 | 创建群组 + 更新状态 | `active` |
| `pending` | 创建失败且未达上限 | 记录错误 + 递增计数器 | `pending` |
| `pending` | 创建失败且达上限（5次） | 记录错误 | `failed` |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `lark-cli`/`jq`/`flock`/`timeout` 不可用 | 立即终止执行（exit 1） |
| 创建群组失败（< 5 次） | 记录错误，递增重试计数器，下次重试 |
| 创建群组失败（≥ 5 次） | 标记为 `failed`，记录错误信息 |
| Schedule 崩溃后恢复 | 检测已有 chatId，幂等恢复为 `active` |
| Chat 文件损坏（非 JSON） | 记录警告，跳过该文件 |
| `lark-cli` 超时（> 30s） | 视为创建失败，记录超时错误，进入重试流程 |
| 并发处理同一文件 | `flock -n` 非阻塞锁，跳过已被其他实例处理的文件 |
| `pending` 群聊已过期 | 标记为 `expired`，跳过激活，不消耗重试次数 |
| 非标准 `expiresAt` 格式 | 跳过过期检查（fail-open），不标记为 expired |

## 注意事项

1. **幂等性**: 重复执行不会产生副作用（检测已有 chatId 自动恢复）
2. **有限重试**: 创建失败最多重试 5 次，超限后标记为 `failed`
3. **无状态**: Schedule 不维护内存状态，所有状态从文件读取
4. **串行处理**: 一次处理一个群聊，避免并发问题
5. **不创建新 Schedule**: 这是定时任务执行环境的规则
6. **不修改其他文件**: 只处理 `workspace/chats/` 目录下的文件
7. **并发安全**: 使用 `flock` 文件锁防止多个 Schedule 实例同时处理同一文件
8. **超时保护**: `lark-cli` 调用设 30 秒超时，防止挂起阻塞后续 Schedule
9. **失败记录**: 达到重试上限后标记为 `failed` 并记录错误信息，消费方可轮询检测
10. **过期预检**: 在激活前检查 `expiresAt`，已过期的 pending 群聊直接标记为 `expired`，避免无意义的群组创建
11. **限流保护**: 每次执行最多处理 10 个群聊（`CHAT_MAX_PER_RUN`），防止积压时 API 限流

## 验收标准

- [ ] 能检测并激活 pending 群聊（创建群组）
- [ ] 能正确更新状态为 active
- [ ] 创建群组失败时不影响其他群聊
- [ ] 崩溃恢复后不会重复创建群组（幂等性）
- [ ] 连续失败 5 次后被标记为 failed
- [ ] 环境依赖缺失时立即终止执行
- [ ] 已过期的 pending 群聊被标记为 expired，不尝试创建群组
- [ ] 每次执行最多处理 10 个群聊，不会 API 限流
