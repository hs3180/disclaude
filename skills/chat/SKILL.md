---
name: chat
description: Temporary chat lifecycle management - create, query, list, and respond to temporary chats. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理". Also supports direct user invocation via /chat create|query|list.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Chat Skill — 临时讨论群生命周期管理

按需创建、查询、列出、解散临时飞书讨论群，通过映射表追踪所有群组。

**适用于**: 创建讨论群、查询群信息、列出所有群、解散群
**不适用于**: 发送消息（使用 MCP send_text/send_interactive）、自动超时解散（使用 chat-timeout skill）

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{name}` | Yes (create) | — | 群名称（最长 64 字符） |
| `{description}` | No | — | 群描述 |
| `{purpose}` | No | `discussion` | 群用途标签（discussion, feedback, vote 等） |
| `{key}` | Yes (query/dissolve) | — | 映射表中的 key（如 `discussion-1714800000`） |

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

```json
{
  "pr-123": { "chatId": "oc_xxx", "purpose": "pr-review", "createdAt": "..." },
  "discussion-1714800000": { "chatId": "oc_yyy", "purpose": "discussion", "createdAt": "..." },
  "feedback-456": { "chatId": "oc_zzz", "purpose": "feedback", "createdAt": "..." }
}
```

- **Key 格式**: `{purpose}-{identifier}`（如 `discussion-{timestamp}`）
- **purpose 默认**: `discussion`

## 子命令

### `/chat create` — 创建讨论群

创建临时飞书讨论群，写入映射表，发送 context 消息，然后返回（不阻塞等待回复）。

**执行步骤**:

1. **确定参数**: 从用户输入或调用方上下文中提取 name、description、purpose
2. **生成 key**: `{purpose}-{Date.now()}`（如 `discussion-1714800000`）
3. **检查重复**: 读取映射表，如果同 key 已存在则返回已有 chatId
4. **创建群**:
   ```bash
   lark-cli im chat create --name "{name}" --description "{description}"
   ```
   解析输出获取 chatId（`oc_xxx` 格式）
5. **写入映射**: 追加 `{key}` 条目到 `workspace/bot-chat-mapping.json`
   ```json
   { "{key}": { "chatId": "oc_xxx", "purpose": "{purpose}", "createdAt": "{ISO timestamp}" } }
   ```
   原子写入（先写临时文件再 rename）
6. **发送 context**: 通过 MCP send_text 或 send_interactive 向群内发送讨论上下文
7. **返回**: 输出创建结果（key, chatId, name），不等待用户回复

### `/chat dissolve` — 半手动解散群

用户主动触发解散，Agent 确认后执行。

**执行步骤**:

1. **用户触发**: 用户说「解散群」或在群内发送解散指令，或指定要解散的 key
2. **确认操作**: 向用户确认是否解散（避免误操作），显示群名称和 key
3. **解散群**:
   ```bash
   lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
   ```
4. **清理映射**: 从 `workspace/bot-chat-mapping.json` 中删除对应条目
5. **通知**: 输出解散完成信息

### `/chat list` — 列出所有 Bot 创建的群

读取映射表，展示所有条目。

**执行步骤**:

1. **读取映射表**:
   ```bash
   cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
   ```
2. **格式化输出**: 以表格形式展示所有条目：

   | Key | Chat ID | Purpose | Created |
   |-----|---------|---------|---------|
   | discussion-1714800000 | oc_yyy | discussion | 2024-05-04T... |

3. **统计**: 输出总数和按 purpose 分组计数

### `/chat query` — 查询特定讨论群

查询映射表中的特定条目。

**执行步骤**:

1. **确定 key**: 从用户输入中获取要查询的 key
2. **读取映射表**:
   ```bash
   cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
   ```
3. **查找条目**: 在映射表中查找指定 key
4. **输出结果**: 如果找到，显示完整条目信息；如果未找到，提示不存在

## 映射表操作模式

所有子命令都直接通过 Read + Edit/Write 操作 `workspace/bot-chat-mapping.json`：

- **读取**: `cat workspace/bot-chat-mapping.json` 或 Read 工具
- **写入**: Edit 工具追加条目，或 Write 工具原子替换
- **删除**: Edit 工具删除指定 key 行，或 Read → 修改 → Write

## 错误处理

- `lark-cli` 命令失败 → 记录错误，向用户报告
- 映射文件读取失败 → 视为空表（{}）
- 映射文件写入失败 → 记录错误（可通过 `lark-cli im chats list --as bot` 重建）
- 群创建失败 → 不写入映射表，向用户报告错误
- 群解散失败 → 不删除映射条目，保留记录以便重试
- key 已存在（create） → 返回已有 chatId，不重复创建

## 设计原则

1. **纯 SKILL.md** — 零 TypeScript 代码，Agent 按指引操作
2. **映射表是缓存** — 可通过 `lark-cli im chats list --as bot` 重建
3. **用户驱动解散** — Agent 不自主解散群，需用户确认
4. **幂等操作** — 映射表过滤防重复创建
5. **不引入 ChatStore** — 无 TTL、无状态机、无自动过期
6. **复用 BotChatMappingStore** — 统一的映射表，支持任意 purpose

## lark-cli 命令参考

```bash
# 创建群
lark-cli im chat create --name "讨论主题" --description "描述内容"

# 解散群
lark-cli api DELETE /open-apis/im/v1/chats/{chatId}

# 查看群列表（用于重建映射）
lark-cli im chats list --as bot
```

## 依赖

`lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）

## 关联

- Parent: #631
- 基础设施: #2945, #2947, #2946
- 参考: PR Scanner (`skills/pr-scanner/SKILL.md`) 的纯 SKILL.md 模式
