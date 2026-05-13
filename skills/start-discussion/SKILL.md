---
name: start-discussion
description: Initiate a non-blocking discussion by creating a Feishu group, sending context, and recording the mapping. Use when the agent identifies a topic needing deeper discussion with the user, wants to delegate an offline question, or needs to spawn a sub-agent conversation without blocking current work. Keywords: 'start discussion', '发起讨论', '创建讨论群', '离线提问', 'offline question', 'start-discussion', '非阻塞讨论'.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Start Discussion — 非阻塞讨论发起

创建飞书讨论群、发送上下文、记录映射，**立即返回**不阻塞当前工作。

**适用于**: 发起讨论、离线提问、创建讨论群、非阻塞交互 ｜ **不适用于**: 解散群、PR Review（用 pr-scanner）

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{topic}` | Yes | — | 讨论主题（简短描述） |
| `{context}` | Yes | — | 发送给讨论群的上下文内容 |
| `{identifier}` | No | 当前消息 ID | 映射键标识符，用于 bot-chat-mapping.json |
| `{members}` | No | — | 额外成员 open_id 列表（逗号分隔） |

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

- **Key**: `discussion-{identifier}` → `purposeFromKey()` 推断 purpose = `discussion`
- **群名**: `讨论 · {topic前30字}`

## 执行步骤

### 1. 确定 identifier

如果调用者未提供 `{identifier}`，使用当前消息的 messageId 作为默认值。

### 2. 检查映射表 — 避免重复创建

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

查找 key `discussion-{identifier}` 是否已存在。如果存在，直接使用已有的 `chatId` 跳到步骤 4。

### 3. 创建讨论群

```bash
# 创建群聊（bot 身份）
# 群名格式: "讨论 · {topic前30字}"
# topic 中的特殊字符需要转义
lark-cli im +chat-create --name "讨论 · {topic前30字}" --description "非阻塞讨论群"

# 如果有额外成员，添加 --users 参数
lark-cli im +chat-create --name "讨论 · {topic前30字}" --description "非阻塞讨论群" --users "{members}"
```

从命令输出中提取新群的 `chatId`（`oc_` 开头的字符串）。

### 4. 写入映射

将 `discussion-{identifier}` 条目追加到 `workspace/bot-chat-mapping.json`：

```json
{
  "discussion-{identifier}": {
    "chatId": "{chatId}",
    "createdAt": "{ISO timestamp}",
    "purpose": "discussion"
  }
}
```

使用原子写入（先写临时文件再 rename）。

### 5. 发送上下文

使用 MCP 工具向讨论群发送上下文消息：

**选项 A — 简单文本**:
```
使用 send_text 工具:
- text: {context}
- chatId: {chatId}
```

**选项 B — 交互卡片**（推荐，适合结构化内容）:
```
使用 send_interactive 工具:
- title: "讨论: {topic}"
- question: {context}
- options: [{"text": "✅ 确认", "value": "confirm"}, {"text": "❌ 拒绝", "value": "reject"}]
- chatId: {chatId}
```

### 6. 返回结果

```
✅ 讨论群已创建
- 群名: 讨论 · {topic前30字}
- chatId: {chatId}
- 映射 key: discussion-{identifier}
- 上下文已发送
```

**立即返回**，不等待用户回复。后续用户在讨论群中的交互由 ChatAgent 异步处理。

## 群解散

讨论群不应由本 skill 自动解散。解散逻辑由 chat-timeout skill 或手动处理。

手动解散命令（如需要）：
```bash
lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
```

## 错误处理

- `lark-cli` 命令失败 → 记录错误，返回失败原因
- 映射文件读取失败 → 视为空表，继续创建
- 映射文件写入失败 → 记录错误（可通过群名重建）
- 群创建失败 → 返回错误，不发送上下文

## 设计原则

1. **非阻塞** — 创建群 + 发送上下文后立即返回
2. **幂等操作** — 映射表过滤防重复创建
3. **原子能力** — 群管理用 lark-cli，消息发送用 MCP，不组合为单一 MCP 工具
4. **映射表是缓存** — 可从飞书 API 重建

## 依赖

`lark-cli` (飞书官方 CLI) · `workspace/bot-chat-mapping.json`（BotChatMappingStore） · MCP send_text/send_interactive

## 关联

- Issue: #631 (离线提问 — Agent 不阻塞工作的留言机制)
- Depends on: #2947 (BotChatMappingStore)
- Related: pr-scanner skill (类似模式参考)
- Related: rename-group skill (lark-cli 使用参考)
