---
name: start-discussion
description: Initiate a non-blocking discussion by creating a Feishu group, sending context, and recording the mapping. Use when the agent identifies a topic needing deeper discussion with the user, wants to delegate an offline question, or needs to spawn a sub-agent conversation without blocking current work. Keywords: 'start discussion', '发起讨论', '创建讨论群', '离线提问', 'offline question', 'start-discussion', '非阻塞讨论'.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Start Discussion — 非阻塞讨论发起

在当前工作不中断的前提下，针对某个话题创建飞书讨论群、发送上下文材料、记录映射，然后立即返回。

**适用于**: 发起讨论、离线提问、委托 sub-agent 讨论 ｜ **不适用于**: 管理 PR 讨论群（用 pr-scanner）、改群名（用 rename-group）、解散群

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{topic}` | Yes | — | 讨论主题（用于群名和上下文） |
| `{context}` | Yes | — | 发送给讨论群的背景材料 |
| `{users}` | No | — | 参与者 open_id 列表（逗号分隔） |
| `{parentChatId}` | Yes | — | 当前会话 chatId（从消息头获取） |

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header) → used as `{parentChatId}`

## 执行步骤

### 1. 确认讨论必要性

在创建群之前，确认以下条件满足：
- 当前对话中确实有一个需要深入探讨的话题
- 话题不适合在当前对话中直接解决（如需要多人参与、需要较长时间讨论、需要用户后续反馈）

### 2. 生成讨论标识

基于 `{topic}` 生成：
- **群名**: `{topic前30字}` — 简洁明了的讨论主题（最多 64 字符，超出截断）
- **映射 key**: `discussion-{YYYYMMDDHHmmss}` — 使用时间戳保证唯一性

### 3. 创建飞书讨论群

```bash
# 创建群聊（bot 身份）
lark-cli im chat create --name "{群名}" --description "讨论：{topic}"
```

从命令输出中提取返回的 `chat_id`（格式 `oc_xxx`）。

> **错误处理**: 如果创建失败，向用户报告错误并停止。不要重试。

### 4. 记录映射

将映射写入 `workspace/bot-chat-mapping.json`：

```bash
# 读取现有映射
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

追加新条目（保持 JSON 格式正确）：

```json
{
  "discussion-{YYYYMMDDHHmmss}": {
    "chatId": "oc_xxx",
    "createdAt": "{ISO timestamp}",
    "purpose": "discussion"
  }
}
```

### 5. 发送上下文到讨论群

使用 MCP 工具向新创建的群发送上下文材料：

**发送欢迎消息**（使用 MCP `send_text` 或 `send_card` 工具）：

```
📋 讨论主题: {topic}

背景材料:
{context}

---
本讨论由 Agent 自动创建，请在群中继续讨论。
```

> **注意**: 消息发送使用 MCP 工具（`mcp__channel-mcp__send_text` 或 `mcp__channel-mcp__send_card`），不使用 lark-cli。

### 6. 向当前对话汇报

向 `{parentChatId}` 发送确认消息：

```
✅ 已创建讨论群「{群名}」，上下文已发送。
群聊 ID: oc_xxx

请在飞书中查看并参与讨论。
```

### 7. 立即返回

完成上述步骤后，立即返回当前工作流。不要等待讨论结果。

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| lark-cli 不可用 | 向用户报告缺少依赖，停止 |
| 群创建失败 | 报告错误，不重试，不写入映射 |
| 映射文件读取失败 | 视为空表，创建新映射 |
| 映射文件写入失败 | 报告错误（可通过群名重建映射） |
| MCP 消息发送失败 | 报告错误，群已创建，映射已记录 |

## 设计原则

1. **非阻塞** — 创建群 + 发送上下文后立即返回，不等待回复
2. **幂等创建** — 不检查是否已有同主题群，每次调用创建新群
3. **映射可重建** — 映射是缓存，可从飞书 API 重建
4. **用户驱动解散** — Bot 不自主解散讨论群
5. **群操作走 lark-cli** — 创建群用 lark-cli，消息发送用 MCP

## 依赖

`lark-cli` CLI · `workspace/bot-chat-mapping.json`（BotChatMappingStore）· MCP send_text/send_card

## 关联

- Parent: #631
- Depends on: BotChatMappingStore (`packages/core/src/scheduling/bot-chat-mapping.ts`)
- Related: pr-scanner skill（群创建模式参考）
