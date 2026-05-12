---
name: start-discussion
description: Initiate a non-blocking discussion by creating a Feishu group, sending context, and recording the mapping. Use when the agent identifies a topic needing deeper discussion with the user, wants to delegate an offline question, or needs to spawn a sub-agent conversation without blocking current work. Keywords: 'start discussion', '发起讨论', '创建讨论群', '离线提问', 'offline question', 'start-discussion', '非阻塞讨论'.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Start Discussion — 非阻塞讨论发起

Agent 识别到需要深入讨论的话题时，创建飞书讨论群并发送上下文，不阻塞当前工作流。

**适用于**: 发起非阻塞讨论、离线提问、委托子 Agent 对话 ｜ **不适用于**: 用户主动发起的临时会话（用 `/chat create`）、解散群（用 `/chat dissolve`）

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{topic}` | Yes | — | 讨论主题（简短描述，用于群名） |
| `{context}` | Yes | — | 讨论背景和上下文信息 |
| `{creatorChatId}` | Yes | — | 发起方的 chatId（用于关联） |
| `{recipients}` | No | — | 需要邀请的飞书用户 openId 列表 |

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

- **Key**: `discussion-{timestamp}` → `purposeFromKey()` 推断 purpose
- **群名**: `讨论 · {topic前25字}` → 与 `chat` skill 保持一致
- **Purpose**: `"discussion"`

## 执行步骤

### 1. 生成 key

```bash
echo "discussion-$(date +%s)"
```

记录生成的 key，后续步骤使用。

### 2. 检查映射表防重复

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

如果已存在相同 `topic` 的活跃讨论群（同一天内、purpose 为 `"discussion"`），考虑是否复用已有群而非重复创建。

### 3. 创建飞书讨论群

```bash
lark-cli im chat create --name "讨论 · {topic前25字}" --description "{context前100字}"
```

从输出中提取 chatId（`oc_xxx` 格式）。

### 4. 邀请参与者（可选）

如果 `{recipients}` 非空，逐一邀请：

```bash
lark-cli im chat_members add --chat-id {chatId} --member-id-type open_id --id {openId}
```

### 5. 发送上下文消息

通过 MCP `send_text` 或 `send_card` 向新群发送讨论上下文：

- 讨论主题
- 背景信息（`{context}`）
- 发起原因
- 期望的讨论方向或问题

示例消息格式：

```
📋 讨论已发起

**主题**: {topic}

**背景**: {context}

请在此群中讨论以上话题。讨论完成后，可以回复"结束讨论"来关闭此群。
```

### 6. 写入映射表

读取 `workspace/bot-chat-mapping.json`，追加条目并原子写入：

```json
{
  "{key}": {
    "chatId": "{chatId}",
    "createdAt": "{ISO timestamp}",
    "purpose": "discussion"
  }
}
```

### 7. 向发起方报告

在 `{creatorChatId}` 中报告讨论群已创建：

```
✅ 讨论群已创建
- 群名: 讨论 · {topic前25字}
- chatId: {chatId}
- 参与者已收到上下文消息
```

## 错误处理

- `lark-cli` 命令失败 → 记录错误，向发起方报告失败
- 映射文件读取失败 → 视为空表，继续创建
- 映射文件写入失败 → 记录错误（可通过群名重建）
- MCP 发送消息失败 → 记录错误，映射仍写入（群已创建）
- 邀请用户失败 → 跳过该用户，继续后续步骤

## 设计原则

1. **非阻塞** — 创建讨论群后立即返回，不等待讨论结果
2. **纯 SKILL.md** — 零 TypeScript 代码，Agent 通过 lark-cli 和文件操作完成
3. **复用 BotChatMappingStore** — 统一的 `bot-chat-mapping.json`，purpose 为 `"discussion"`
4. **幂等操作** — 映射表过滤防重复创建（同一天同 topic）
5. **上下文完整** — 发送充分的背景信息，确保参与者无需额外查询即可开始讨论
6. **与 chat skill 兼容** — 使用相同的群名格式和映射结构，`/chat list` 和 `/chat query` 可查询

## 与其他 Skill 的关系

| Skill | 关系 |
|-------|------|
| **chat** | `start-discussion` 创建群后，群的生命周期由 `chat` skill 管理（list/query/dissolve） |
| **chat-timeout** | 超时检测可自动触发解散流程 |
| **survey** | 讨论中可发起投票收集意见 |
| **pr-scanner** | PR Scanner 可调用 `start-discussion` 为新 PR 创建审查讨论群 |

## 依赖

`lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）

## 关联

- Parent: #2191
- 依赖: chat skill (#3283), BotChatMappingStore (#2947)
