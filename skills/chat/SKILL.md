---
name: chat
description: "Temporary chat lifecycle management - create, query, list, and dissolve Feishu discussion groups. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like '临时会话', '创建临时会话', 'temporary chat', '/chat create', '发起讨论', '会话管理'. Also supports direct user invocation via /chat create|query|list."
allowed-tools: [Bash, Read, Write, Glob, send_text, send_interactive, send_card]
---

# Chat — 临时群聊生命周期管理

管理 Bot 创建的临时讨论群：创建、查询、列表、解散。

**适用于**: 创建讨论群、查询群信息、列出所有群、解散群 | **不适用于**: PR 审查群（用 PR Scanner skill）、发起非阻塞讨论（用 start-discussion skill）

## Commands

| Command | Description |
|---------|-------------|
| `/chat create` | 创建临时讨论群并写入映射表 |
| `/chat query <key>` | 查询特定讨论群信息 |
| `/chat list` | 列出所有 Bot 创建的群 |
| `/chat dissolve <key>` | 半手动解散群并清理映射表 |

## Context Variables

When invoked, you receive:
- **Chat ID**: Source chat where the command was triggered (from `**Chat ID:** xxx` in message header)
- **Message ID**: The triggering message ID
- **Sender Open ID**: The user who triggered the command

## Data Structure

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

Key 格式: `{purpose}-{identifier}`，例如 `discussion-1714800000`、`feedback-456`

每个条目:
```json
{
  "chatId": "oc_xxx",
  "createdAt": "ISO timestamp",
  "purpose": "discussion"
}
```

## /chat create — 创建讨论群

### 步骤

**1. 确定讨论主题**

从用户输入或 Agent 上下文中提取:
- **主题 (topic)**: 群名称（max 64 chars）
- **描述 (description)**: 群描述（可选）
- **参与者 (participants)**: 用户 Open ID 列表（可选）

**2. 检查重复**

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

检查是否已有相同主题的讨论群。如果映射表中存在 `purpose: 'discussion'` 且群名完全匹配的条目，告知用户并询问是否仍要创建。

**3. 创建群**

```bash
lark-cli im +chat-create --name "{topic}" --description "{description}"
```

如需添加参与者:
```bash
lark-cli im +chat-create --name "{topic}" --users "ou_xxx,ou_yyy"
```

从输出解析新群的 `chatId`（格式: `oc_xxx`）。

**4. 写入映射**

使用当前 Unix 时间戳作为 key 的一部分:

```bash
TIMESTAMP=$(date +%s)
KEY="discussion-${TIMESTAMP}"
```

追加到映射表:
```json
{
  "discussion-{timestamp}": {
    "chatId": "oc_xxx",
    "createdAt": "{ISO timestamp}",
    "purpose": "discussion"
  }
}
```

原子写入（写临时文件后 rename）:
```bash
cat workspace/bot-chat-mapping.json | jq '. + {"discussion-{timestamp}": {"chatId":"oc_xxx","createdAt":"...","purpose":"discussion"}}' > workspace/bot-chat-mapping.json.tmp && mv workspace/bot-chat-mapping.json.tmp workspace/bot-chat-mapping.json
```

如果 `jq` 不可用，用 Read 工具读取 → 手动构造 JSON → Write 工具写入。

**5. 发送上下文消息**

通过 MCP 工具向新群发送初始上下文:

```
send_text 或 send_interactive → chatId = 新群 chatId
```

内容包含: 讨论主题、背景信息、参与指引。

**6. 确认**

向源聊天报告创建结果:
> 已创建讨论群「{topic}」，chatId: `{oc_xxx}`

## /chat list — 列出所有群

### 步骤

**1. 读取映射表**

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

**2. 展示结果**

将所有条目格式化为可读列表。如果条目过多，只展示 key、chatId、purpose、createdAt。

如果映射表为空:
> 当前没有 Bot 创建的讨论群。

**3. 可选: 从飞书 API 验证**

如果需要验证群是否仍然存在:
```bash
lark-cli im chats list --as bot
```

对比映射表与实际群列表，标注已不存在的群。

## /chat query \<key\> — 查询特定群

### 步骤

**1. 读取映射表**

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

**2. 查找条目**

根据用户提供的 key（如 `discussion-1714800000` 或 `pr-123`）查找。

**3. 展示结果**

如果找到:
> 讨论群 `{key}`: chatId=`{chatId}`, purpose=`{purpose}`, 创建时间=`{createdAt}`

如果未找到:
> 未找到 key 为 `{key}` 的讨论群。使用 `/chat list` 查看所有群。

**4. 支持 chatId 查询**

如果用户提供的不是 key 而是 `oc_xxx` 格式的 chatId，遍历映射表查找匹配的条目。

## /chat dissolve \<key\> — 解散群

### 步骤

**1. 确认操作**

解散群是不可逆操作，必须先向用户确认:

```
send_interactive:
  question: "确定要解散讨论群「{topic}」({chatId}) 吗？此操作不可撤销。"
  options:
    - text: "确认解散", value: "dissolve-confirm-{key}", type: "danger"
    - text: "取消", value: "dissolve-cancel-{key}"
```

**2. 执行解散**（仅在用户确认后）

```bash
lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
```

**3. 清理映射表**

删除对应条目并原子写入:

```bash
cat workspace/bot-chat-mapping.json | jq 'del(.{"{key}"})' > workspace/bot-chat-mapping.json.tmp && mv workspace/bot-chat-mapping.json.tmp workspace/bot-chat-mapping.json
```

如果 `jq` 不可用，用 Read 工具读取 → 删除条目 → Write 工具写入。

**4. 确认**

向源聊天报告:
> 讨论群「{topic}」已解散，映射已清理。

## Error Handling

| Error | Action |
|-------|--------|
| `lark-cli` not in PATH | Report: "无法执行群操作，lark-cli 未安装" |
| Mapping file not found | Treat as empty table (`{}`) |
| Mapping file corrupted | Report warning, suggest rebuild from `lark-cli im chats list --as bot` |
| Group creation fails | Report error, do not create mapping entry |
| Group dissolve fails | Report error, keep mapping entry (group may still exist) |
| Mapping write fails | Report warning (lark-cli operation succeeded, mapping is a cache) |

## lark-cli Command Reference

| Operation | Command |
|-----------|---------|
| Create group | `lark-cli im +chat-create --name "..." --description "..."` |
| Create group with users | `lark-cli im +chat-create --name "..." --users "ou_xxx,ou_yyy"` |
| Dissolve group | `lark-cli api DELETE /open-apis/im/v1/chats/{chatId}` |
| List bot groups | `lark-cli im chats list --as bot` |
| Send message | `lark-cli im +messages-send --chat-id oc_xxx --text "..."` |
| Add members | `lark-cli im chat.members create --params '{"chat_id":"oc_xxx","member_id_type":"open_id","succeed_type":1}' --data '{"id_list":["ou_aaa"]}'` |

## Design Principles

1. **纯 SKILL.md** — 零 TypeScript 代码，参考 pr-scanner 的成功模式
2. **映射表是缓存** — `bot-chat-mapping.json` 可从飞书 API 重建
3. **用户驱动解散** — 需确认后才解散，Bot 不自主解散群
4. **幂等操作** — 映射表过滤防重复创建
5. **原子写入** — 先写临时文件再 rename，防数据损坏
6. **复用 BotChatMappingStore** — 不引入新的存储机制

## Integration with Other Skills

| Skill | Relationship |
|-------|-------------|
| `start-discussion` | 发起讨论后，群的解散/查询/列表由本 skill 管理 |
| `chat-timeout` | 自动检测超时的讨论群并解散 |
| `pr-scanner` | 独立管理 PR 审查群（purpose: `pr-review`），与本 skill 共享映射表 |
| `survey` | 投票等交互在讨论群内进行 |

## DO NOT

- DO NOT 引入新的 TypeScript 代码 — 本 skill 纯 SKILL.md
- DO NOT 使用 IPC Channel 做群操作 — 用 `lark-cli` via Bash
- DO NOT 自动解散群 — 必须用户确认
- DO NOT 引入新的存储机制 — 复用 `workspace/bot-chat-mapping.json`
- DO NOT 管理 PR 审查群 — 那是 PR Scanner 的职责
