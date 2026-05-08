---
name: chat-timeout
description: Temporary session timeout detection and group dissolution. Detects expired active chats, dissolves groups via lark-cli (when no user response), marks as expired, and cleans up old expired files. Keywords: "chat timeout", "超时检测", "解散群组", "session cleanup", "群聊超时".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Chat Timeout — 临时群聊超时检测与解散

检测映射表中的活跃群聊，发现超时无活动的群聊后执行生命周期关闭流程。

**适用于**: 超时检测、群聊生命周期管理、自动解散｜**不适用于**: 创建群聊、发送消息（使用 chat skill）

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{controlChannelChatId}` | Yes | — | Schedule execution context chatId，用于发送超时报告 |
| `{inactiveThresholdHours}` | No | `24` | 无活动后触发超时警告的小时数 |
| `{warningExpiryHours}` | No | `4` | 发出警告后等待响应的小时数，超时则解散 |
| `{maxPurposes}` | No | `discussion` | 逗号分隔的 purpose 列表，限定检测范围。`all` 检测全部 |

## 数据结构

### 映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

读取所有指定 purpose 的映射条目，获取 chatId 和 createdAt。

### 超时状态文件: `workspace/chat-timeout-state.json`

记录每个群聊的超时检测状态：

```json
{
  "discussion-1234567890": {
    "chatId": "oc_xxx",
    "lastActivityAt": "2026-05-07T10:00:00Z",
    "warningSentAt": null,
    "status": "active"
  },
  "discussion-9876543210": {
    "chatId": "oc_yyy",
    "lastActivityAt": "2026-05-06T08:00:00Z",
    "warningSentAt": "2026-05-07T08:00:00Z",
    "status": "warning"
  }
}
```

**状态流转**: `active` → `warning` → `expired` → （从状态文件中移除）

## 执行步骤

### 1. 读取映射表

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

提取所有匹配 purpose 的映射条目。如果 `{maxPurposes}` 为 `all`，则处理所有条目。

### 2. 读取超时状态文件

```bash
cat workspace/chat-timeout-state.json 2>/dev/null || echo "{}"
```

文件不存在则视为空状态。对映射表中每个条目：
- 如果状态文件中有记录，使用 `lastActivityAt` 和 `warningSentAt`
- 如果状态文件中没有记录，以映射条目的 `createdAt` 作为初始 `lastActivityAt`

### 3. 检测每个群聊的最后活动时间

对每个映射条目，查询群聊最新消息以确定最后活动时间：

```bash
lark-cli api GET "/open-apis/im/v1/messages?container_id_type=chat&container_id={chatId}&page_size=1&sort_type=ByCreateTimeDesc" 2>/dev/null | jq -r '.data.items[0].create_time // empty'
```

如果 API 返回消息，用消息的 `create_time` 更新 `lastActivityAt`。
如果 API 返回空（无消息）或失败，保持 `lastActivityAt` 不变（使用 `createdAt`）。

### 4. 分类处理

对每个群聊，根据当前时间和状态判断处理方式：

| 条件 | 状态 | 处理 |
|------|------|------|
| `lastActivityAt` 距今 < `{inactiveThresholdHours}`h | `active` | **跳过** — 仍在活跃 |
| `lastActivityAt` 距今 ≥ `{inactiveThresholdHours}`h 且无 warning | `active` → `warning` | **发送超时警告** |
| 已发 warning 且 `warningSentAt` 距今 < `{warningExpiryHours}`h | `warning` | **跳过** — 等待用户响应 |
| 已发 warning 且 `warningSentAt` 距今 ≥ `{warningExpiryHours}`h | `warning` → `expired` | **解散群组** |

### 5. 发送超时警告

对需要发送警告的群聊，向群聊发送交互式卡片消息：

```bash
# 通过 lark-cli 发送超时提醒消息
lark-cli api POST /open-apis/im/v1/messages \
  -d '{
    "receive_id": "{chatId}",
    "msg_type": "interactive",
    "content": "{\"config\":{\"wide_screen_mode\":true},\"header\":{\"title\":{\"content\":\"群聊超时提醒\",\"tag\":\"plain_text\"},\"template\":\"orange\"},\"elements\":[{\"tag\":\"markdown\",\"content\":\"该群聊已超过 {inactiveThresholdHours} 小时无活动。\\n\\n如需继续讨论，请发送任意消息。\\n如不再需要，该群聊将在 **{warningExpiryHours} 小时** 后自动解散。\"}]}"
  }' \
  -d 'receive_id_type=chat_id'
```

如果 lark-cli 不支持直接发送消息（需要 IPC），则在 `workspace/chat-timeout-state.json` 中记录 `warningSentAt` 时间戳，并输出警告日志到控制台。下次调度时如果仍有新消息活动，会将状态重置为 `active`。

**重要**: 在实际运行中，Agent 使用 MCP 工具 `send_user_feedback` 发送消息。此步骤应使用可用的消息发送机制向群聊发送超时提醒。

### 6. 解散超时群组

对已过警告期的群聊，执行解散流程：

**6a. 解散飞书群组**:
```bash
lark-cli api DELETE "/open-apis/im/v1/chats/{chatId}" 2>&1
```

如果 API 返回成功（无错误），继续下一步。如果失败（群组不存在、权限不足等），记录错误日志但仍继续清理映射表。

**6b. 清理映射表**:
从 `workspace/bot-chat-mapping.json` 中移除该条目：
```bash
# 读取当前映射表
cat workspace/bot-chat-mapping.json | jq 'del(.["{key}"])' > workspace/bot-chat-mapping.json.tmp
mv workspace/bot-chat-mapping.json.tmp workspace/bot-chat-mapping.json
```

**6c. 清理状态文件**:
从 `workspace/chat-timeout-state.json` 中移除该条目：
```bash
cat workspace/chat-timeout-state.json | jq 'del(.["{key}"])' > workspace/chat-timeout-state.json.tmp
mv workspace/chat-timeout-state.json.tmp workspace/chat-timeout-state.json
```

### 7. 发送超时报告

向控制频道（`{controlChannelChatId}`）发送本轮超时检测报告：

```
📋 Chat Timeout Report

⚠️ Warnings Sent: {count}
  - {key}: last active {hours}h ago

🗑️ Groups Dissolved: {count}
  - {key}: dissolved after {totalHours}h of inactivity

✅ Active Groups: {count}
  - All within threshold
```

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| 映射文件读取失败 | 视为空映射表，跳过 |
| 状态文件读取失败 | 视为空状态，使用 createdAt 初始化 |
| lark-cli 消息查询失败 | 保持 lastActivityAt 不变，下次重试 |
| lark-cli 解散群组失败 | 记录错误日志，仍清理本地映射和状态 |
| 映射文件写入失败 | 记录错误，不中断流程 |
| 群组已不存在（404） | 视为已解散，清理本地数据 |

## 设计原则

1. **渐进式超时** — 先警告后解散，不直接删除活跃群聊
2. **幂等操作** — 多次执行不会产生副作用（状态文件去重）
3. **容错优先** — API 失败不阻塞流程，保持本地数据一致性
4. **可配置阈值** — 不同部署环境可调整超时时间
5. **最小权限** — 只解散经过明确超时流程的群聊

## 依赖

`lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）· `jq`（JSON 处理）

## Schedule 模板

见同目录下的 `schedule.md`。将其复制到 `schedules/chat-timeout/SCHEDULE.md`，替换 `{controlChannelChatId}` 后启用。

## 关联

- Parent: #2191 (临时群聊讨论)
- Depends on: #3283 (chat skill), #2947 (BotChatMappingStore)
- Complements: chat skill 的 `/chat dissolve` 命令（用户手动解散）
