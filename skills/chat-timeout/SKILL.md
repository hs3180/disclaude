---
name: chat-timeout
description: Temporary session timeout detection and group dissolution. Detects expired active chats, dissolves groups via lark-cli (when no user response), marks as expired, and cleans up old expired files. Triggered by scheduler for automated execution. Keywords: "会话超时", "解散群组", "清理过期会话", "chat timeout", "session cleanup".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Chat Timeout — 临时会话超时检测与群组解散

检测过期的临时会话，解散对应的飞书群组，清理映射和记录文件。

**适用于**: 定时检测超时会话、解散过期群、清理残留文件 | **不适用于**: 创建群、发送消息、管理非临时群

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{controlChannelChatId}` | Yes | — | Schedule execution context chatId (for reporting) |
| `{retentionDays}` | No | `7` | Days to retain expired record files before cleanup |

## 数据结构

临时会话记录: `workspace/schedules/.temp-chats/{chatId}.json`（ChatStore）

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

## 执行步骤

### 1. 读取所有临时会话记录

```bash
ls workspace/schedules/.temp-chats/*.json 2>/dev/null || echo "NO_FILES"
```

如果返回 `NO_FILES`，输出以下消息并结束：

```
✅ Chat Timeout: 无活跃临时会话，无需处理。
```

### 2. 解析并分类

对每个 JSON 文件：

```bash
cat workspace/schedules/.temp-chats/{filename}
```

解析 JSON，提取以下字段：
- `chatId`: 群组 ID
- `expiresAt`: 过期时间 (ISO string)
- `response`: 用户响应数据（如有）
- `creatorChatId`: 创建者 chatId（如有）
- `context`: 附加上下文（如有）

分类为：
- **过期且未响应**: `expiresAt < now` 且 `response` 为空 → 需要解散
- **已响应**: `response` 不为空 → 跳过（由创建流程处理）
- **未过期**: `expiresAt >= now` → 跳过

### 3. 解散过期群组

对每个**过期且未响应**的临时会话，依次执行：

#### 3a. 解散飞书群

```bash
lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
```

如果返回成功（HTTP 200），继续下一步。如果返回 `404`（群已不存在），也继续清理。其他错误记录日志，跳过该会话。

#### 3b. 清理映射表

读取 `workspace/bot-chat-mapping.json`，删除 key 中包含该 `chatId` 的映射条目：

```bash
# 读取当前映射
cat workspace/bot-chat-mapping.json
```

遍历所有 key-value 对，删除 `value.chatId === {chatId}` 的条目，原子写回文件。

#### 3c. 删除临时会话记录

```bash
rm workspace/schedules/.temp-chats/{filename}
```

#### 3d. 通知创建者（可选）

如果 `creatorChatId` 存在且不等于 `{controlChannelChatId}`，使用 `send_text` 发送通知：

```
⏰ 临时会话已超时

群聊 {chatId} 因长时间无响应已自动解散。
如有需要，可以重新创建。
```

### 4. 清理旧过期文件

删除所有超过 `{retentionDays}` 天的临时会话记录文件（无论是否有响应）：

```bash
find workspace/schedules/.temp-chats/ -name "*.json" -mtime +{retentionDays} -delete
```

这一步确保已处理但残留的旧文件被定期清理。

### 5. 输出报告

汇总本次执行结果：

```
📋 Chat Timeout 执行报告

| 指标 | 数量 |
|------|------|
| 扫描会话 | {total} |
| 过期未响应 | {expired} |
| 已解散 | {dissolved} |
| 解散失败 | {failed} |
| 清理旧文件 | {cleaned} |
```

如果 `{dissolved} > 0`，使用 `send_text` 将报告发送到 `{controlChannelChatId}`。

## 错误处理

- `lark-cli` 命令失败 → 记录错误，跳过该群，继续处理其他
- 映射文件读取失败 → 视为空映射，仅删除会话记录
- 映射文件写入失败 → 记录错误（可通过群名重建）
- 单个 JSON 解析失败 → 跳过该文件，继续处理其他
- `send_text` 失败 → 记录错误，不影响主流程

## 设计原则

1. **幂等操作** — 重复执行不会造成副作用（群已解散返回 404，文件已删除跳过）
2. **优雅降级** — 单个群解散失败不影响其他群的处理
3. **用户友好** — 解散前不做额外询问（已由过期时间隐含同意），解散后通知创建者
4. **纯 SKILL.md** — 仅指导文件，零 TypeScript 代码

## 依赖

`lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）· `workspace/schedules/.temp-chats/`（ChatStore）

## Schedule 模板

见同目录下的 `schedule.md`。将其复制到 `schedules/chat-timeout/SCHEDULE.md`，替换 `{controlChannelChatId}` 后启用。

## 关联

- Parent: #2191
- Depends on: ChatStore (#1703), BotChatMappingStore (#2947)
