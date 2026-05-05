---
name: chat
description: Temporary chat lifecycle management - create, query, list, and dissolve temporary discussion groups. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions, but also supports direct user invocation. Keywords: "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理", "建群", "解散群", "chat create", "chat dissolve", "chat list", "chat query".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Chat — 临时会话生命周期管理

管理 Bot 创建的讨论群：创建、解散、列表、查询。通过 `lark-cli` 操作飞书群组，通过 `bot-chat-mapping.json` 追踪映射。

**适用于**: 创建讨论群、解散群、查询/列出群映射 ｜ **不适用于**: 发送消息（使用 MCP 工具）、重命名群（使用 rename-group skill）

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{subcommand}` | Yes | — | `create` / `dissolve` / `list` / `query` |
| `{name}` | create only | — | 群名（max 64 chars，自动截断） |
| `{description}` | create only | `""` | 群描述 |
| `{key}` | query only | — | 映射 key（如 `discussion-1714800000`） |
| `{chatId}` | dissolve only | — | 要解散的群 chatId（`oc_xxx` 格式） |

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

```json
{
  "pr-123": { "chatId": "oc_xxx", "purpose": "pr-review", "createdAt": "..." },
  "discussion-1714800000": { "chatId": "oc_yyy", "purpose": "discussion", "createdAt": "..." },
  "feedback-456": { "chatId": "oc_zzz", "purpose": "feedback", "createdAt": "..." }
}
```

- **Key**: `{purpose}-{identifier}` → `purposeFromKey()` 推断 purpose
- **Purpose**: `pr-review`, `discussion`, `feedback`, 或任意自定义字符串

---

## `/chat create` — 创建讨论群

### 执行步骤

#### 1. 截断群名（CJK 安全）

群名超过 64 字符时按字符边界截断:

```bash
TRUNCATED_NAME=$(node -e "console.log(Array.from('{name}').slice(0, 64).join(''))")
echo "Group name: $TRUNCATED_NAME"
```

#### 2. 生成映射 key

使用当前 Unix 时间戳:

```bash
KEY="discussion-$(date +%s)"
echo "Mapping key: $KEY"
```

#### 3. 创建群

```bash
lark-cli im chat create --name "$TRUNCATED_NAME" --description "{description}"
```

解析输出获取 `chatId`（`oc_xxx` 格式）。如果命令失败，记录错误并停止。

#### 4. 写入映射表

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

#### 5. 返回结果

```
✅ 讨论群已创建

群名: {name}
Chat ID: {chatId}
映射 key: {key}
```

---

## `/chat dissolve` — 解散讨论群

**⚠️ 此操作不可逆** — 需要用户确认后再执行。

### 执行步骤

#### 1. 确认操作

向用户确认解散操作:

```
⚠️ 确认要解散群 {chatId} 吗？此操作不可逆。
请回复"确认"继续。
```

如果用户未明确确认，停止执行。

#### 2. 解散群

```bash
lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
```

如果命令失败，记录错误并向用户报告。

#### 3. 清理映射表

读取映射表，找到 `chatId` 对应的 key，使用 Edit 工具删除该条目:

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

删除匹配 `{chatId}` 的映射条目。

#### 4. 返回结果

```
✅ 讨论群已解散

Chat ID: {chatId}
映射表已清理。
```

---

## `/chat list` — 列出所有 Bot 创建的群

### 执行步骤

#### 1. 读取映射表

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

#### 2. 展示列表

将所有条目格式化为列表:

```
📋 Bot 创建的讨论群 ({count} 个)

| Key | Chat ID | Purpose | Created |
|-----|---------|---------|---------|
| pr-123 | oc_xxx | pr-review | 2026-05-01 |
| discussion-1714800000 | oc_yyy | discussion | 2026-05-04 |
```

如果映射表为空:

```
📋 Bot 尚未创建任何讨论群。
```

---

## `/chat query <key>` — 查询特定讨论群

### 执行步骤

#### 1. 读取映射表

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

#### 2. 查找并展示

查找 key 对应的条目:

```
📋 讨论群详情

Key: {key}
Chat ID: {chatId}
Purpose: {purpose}
Created: {createdAt}
```

如果未找到:

```
❌ 未找到 key 为 "{key}" 的映射条目。
```

---

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| `lark-cli` 未安装 | 记录警告，提示需要安装 `@larksuite/cli` |
| 群创建失败 | 记录错误，向用户报告失败 |
| 群解散失败 | 记录错误，不删除映射条目（保留记录用于恢复） |
| 映射表读取失败 | 视为空映射表，提示用户 |
| 映射表写入失败 | 记录错误（可从群名重建映射） |
| 查询的 key 不存在 | 返回未找到提示 |

## 设计原则

1. **映射表是缓存** — 可从飞书 API 重建
2. **用户驱动解散** — 需要用户确认，Bot 不自主解散群
3. **幂等操作** — 映射表过滤防重复创建
4. **无 TypeScript 代码** — 纯 SKILL.md，Agent 通过 Bash + MCP 操作
5. **复用 BotChatMappingStore** — 不引入新的存储机制
6. **关注点分离** — 群管理用 `lark-cli`，消息发送用 MCP 工具

## 依赖

`lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）

## 关联

- Parent: #631
- 基础设施: #2945, #2947, #2946
- 参考: PR Scanner (`skills/pr-scanner/SKILL.md`) 的纯 SKILL.md 模式
- 互补: `start-discussion` skill（非阻塞讨论发起）
- 替代: PR #3260（被拒绝 — 过度设计）
