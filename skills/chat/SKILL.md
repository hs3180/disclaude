---
name: chat
description: Temporary chat lifecycle management - create, query, list, and respond to temporary chats. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理". Also supports direct user invocation via /chat create|query|list.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Chat — 通用讨论群管理

按需创建飞书讨论群、查询/列表已有群、半手动解散群，通过映射表追踪所有 Bot 创建的群。

**适用于**: 创建讨论群、查询群信息、列出所有群、解散群 ｜ **不适用于**: 发卡片消息（使用 MCP send_interactive）、重命名群（使用 rename-group skill）

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{groupName}` | create 时必填 | — | 群名称（最长 64 字符） |
| `{description}` | No | 空字符串 | 群描述 |
| `{purpose}` | No | `discussion` | 用途标签，用于映射分类 |
| `{identifier}` | No | Unix 时间戳 | 映射 key 中的标识符 |

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

- **Key**: `{purpose}-{identifier}` → 如 `discussion-1714800000`、`feedback-456`
- **群名**: 由调用方指定（最长 64 字符）
- **Purpose**: `discussion`（默认）或自定义用途标签

映射表格式:

```json
{
  "pr-123": { "chatId": "oc_xxx", "purpose": "pr-review", "createdAt": "..." },
  "discussion-1714800000": { "chatId": "oc_yyy", "purpose": "discussion", "createdAt": "..." }
}
```

## 命令

### `/chat create` — 创建讨论群

创建一个新的飞书讨论群并写入映射表。

**执行步骤**:

1. **确定参数**: 从上下文中提取群名称、描述、用途标签
2. **查重**: 检查映射表中是否已存在相同 key 的映射（避免重复建群）

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

3. **创建群**:

```bash
lark-cli im chat create --name "{groupName}" --description "{description}"
```

输出中提取 `chatId`（格式 `oc_xxx`）。

4. **写入映射**: 追加 `{purpose}-{identifier}` 条目到 `workspace/bot-chat-mapping.json`

```json
{
  "{purpose}-{identifier}": {
    "chatId": "oc_xxx",
    "createdAt": "2026-05-09T00:00:00.000Z",
    "purpose": "{purpose}"
  }
}
```

5. **发送 context 消息**（可选）: 通过 MCP `send_text` 或 `send_interactive` 向新群发送引导消息

### `/chat dissolve` — 半手动解散群

用户触发解散，Agent 执行删除并清理映射。

**执行步骤**:

1. **确认操作**: 向用户确认要解散的群（避免误操作）
2. **查找映射**: 从映射表中查找对应的 chatId

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

3. **解散群**:

```bash
lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
```

4. **清理映射**: 从 `workspace/bot-chat-mapping.json` 中删除对应条目
5. **通知完成**: 向用户报告解散结果

### `/chat list` — 列出所有 Bot 创建的群

读取映射表并展示所有条目。

**执行步骤**:

1. **读取映射表**:

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

2. **格式化输出**: 列出所有条目的 key、chatId、purpose、createdAt
3. **空表处理**: 映射表为空时提示 "暂无 Bot 创建的群"

### `/chat query {key}` — 查询特定讨论群

根据 key 查询映射表中的特定条目。

**执行步骤**:

1. **读取映射表**:

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

2. **查找条目**: 根据 `{key}` 查找对应的 chatId、purpose、createdAt
3. **未找到**: 提示 "未找到 key 为 {key} 的映射"

## 错误处理

- 映射文件读取失败 → 视为空表（`{}`）
- 映射文件写入失败 → 记录错误（可通过 `lark-cli im chats list --as bot` 重建）
- 群创建失败 → 报告错误，不写入映射
- 群解散失败（API 返回错误）→ 报告错误，不清理映射（保留记录便于后续重试）
- 群解散失败（群不存在）→ 报告错误，清理映射（群已不存在）

## 设计原则

1. **纯 SKILL.md** — 零 TypeScript 代码，Agent 按引导词执行
2. **映射表是缓存** — 可从飞书 API 重建（`lark-cli im chats list --as bot`）
3. **用户驱动解散** — 不自主解散群，需用户触发并确认
4. **幂等操作** — 映射表查重防重复创建
5. **复用 BotChatMappingStore** — 统一的映射表，支持任意 purpose

## 依赖

`lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）

## 关联

- Parent: #631
- 基础设施: #2945, #2947 (BotChatMappingStore), #2946 (移除 register_temp_chat)
- 参考: `skills/pr-scanner/SKILL.md`（纯 SKILL.md 模式）
- 替代: PR #3260（被拒绝，架构方向错误）
