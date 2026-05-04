---
name: start-discussion
description: Non-blocking discussion initiation - creates a temporary discussion group, sends context, and returns immediately. Use when the Agent identifies a topic needing deeper discussion with users (repeated instructions, user complaints, important decisions, expensive work that may not be needed). Keywords: "离线提问", "发起讨论", "start discussion", "留言", "非阻塞", "offline question", "ask offline", "discuss".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Start Discussion — 非阻塞讨论发起

通过 `lark-cli` 创建临时讨论群，将讨论背景发送给参与者，**立即返回**不阻塞当前工作。

**适用于**: 发起异步讨论、离线提问、非阻塞留言 ｜ **不适用于**: 群组生命周期管理（使用 `/chat`）、即时同步讨论

## 核心原则

1. **纯 SKILL.md** — 无 TypeScript 代码，Agent 通过 Bash + MCP 工具操作
2. **非阻塞** — 创建群、发送消息后立即返回，不等待回复
3. **复用 BotChatMappingStore** — 统一的 `workspace/bot-chat-mapping.json`
4. **关注点分离** — 群管理用 `lark-cli`，消息发送用 MCP 工具

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{topic}` | Yes | — | 讨论主题（1-2 句话概括） |
| `{context}` | Yes | — | 讨论背景材料（供 ChatAgent 了解上下文） |
| `{participants}` | No | — | 参与者 open_id 列表（`ou_xxx` 格式，逗号分隔） |

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## 执行步骤

### Step 1: 生成映射 key

使用当前 Unix 时间戳生成唯一 key:

```bash
KEY="discussion-$(date +%s)"
echo "Mapping key: $KEY"
```

### Step 2: 截断群名

群名超过 64 字符时按字符边界截断（CJK 安全）:

```bash
# 使用 Node.js 截断（正确处理 CJK 字符）
TRUNCATED_NAME=$(node -e "console.log(Array.from('{topic}').slice(0, 64).join(''))")
echo "Group name: $TRUNCATED_NAME"
```

群名格式建议: `💬 {topic摘要}`

### Step 3: 创建讨论群

```bash
lark-cli im chat create --name "💬 $TRUNCATED_NAME" --description "非阻塞讨论: $TRUNCATED_NAME"
```

解析输出获取 `chatId`（`oc_xxx` 格式）。如果命令失败，记录错误并停止。

### Step 4: 添加参与者（如有）

仅当提供了参与者列表时执行:

```bash
lark-cli im chat add-member --chat-id {chatId} --members {participants}
```

如果未指定参与者，讨论群默认仅包含 bot（后续可手动拉人）。

### Step 5: 写入映射表

读取现有映射表:

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

使用 Edit 工具将新条目追加到 JSON:

```json
"discussion-{timestamp}": {
  "chatId": "oc_xxx",
  "purpose": "discussion",
  "createdAt": "2026-05-05T08:00:00.000Z"
}
```

### Step 6: 发送上下文消息

使用 `send_text` MCP 工具向新创建的讨论群发送上下文消息。

**消息内容结构**:

```
📋 讨论背景

## 主题
{topic}

## 背景
{context}

---
此讨论由 Agent 自动发起，请在群内回复您的意见。
```

### Step 7: 返回结果

立即返回以下信息，**不等待用户回复**:

```
✅ 讨论已发起（非阻塞）

群名: 💬 {topic摘要}
Chat ID: {chatId}
映射 key: {key}

已向讨论群发送上下文消息，等待用户回复。
当前工作继续执行。
```

## 触发条件（何时使用此 Skill）

Agent 在以下场景应考虑发起非阻塞讨论:

| 场景 | 示例 |
|------|------|
| **重复指令** | 用户 3+ 次发出相同或类似指令，可能需要讨论根本原因 |
| **用户抱怨** | 用户表达不满或隐性不满（"又出错了"、"怎么还是这样"） |
| **重大决策** | 需要用户确认方向，但不紧急到阻塞当前工作 |
| **花费较大的工作** | 预计耗时长的任务，Agent 认为需要确认是否有价值 |
| **多步修正** | 用户多次修正 Agent 输出，可能需要讨论期望 |

**不应触发的场景**:
- 用户正在等待回复（应直接回答）
- 紧急问题（应即时处理）
- 简单的是/否问题（应直接询问）

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| `lark-cli` 未安装 | 记录警告，提示需要安装 `@larksuite/cli` |
| 群创建失败 | 记录错误，向当前会话报告失败 |
| 映射表写入失败 | 记录错误（可从群名恢复） |
| 消息发送失败 | 记录错误，群已创建但仍可用 |
| 参与者添加失败 | 记录警告，不阻塞后续步骤 |

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`

```json
{
  "discussion-1714800000": {
    "chatId": "oc_xxx",
    "purpose": "discussion",
    "createdAt": "2026-05-05T08:00:00.000Z"
  }
}
```

**Key 格式**: `discussion-{timestamp}` — `purposeFromKey()` 推断 purpose 为 `discussion`

## 设计原则

1. **映射表是缓存** — 可从飞书 API 重建
2. **用户驱动解散** — Bot 不自主解散讨论群（使用 `/chat dissolve`）
3. **幂等操作** — 映射表防止重复创建
4. **非阻塞** — 创建完成后立即返回当前会话

## 依赖

`lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）

## 关联

- Parent: #631
- Related: #3283（chat skill — 群生命周期管理）
- Depends on: BotChatMappingStore (#2947), lark-cli
