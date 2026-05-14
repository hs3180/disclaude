---
name: chat
description: Temporary chat lifecycle management - create, query, list, and respond to temporary chats. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理". Also supports direct user invocation via /chat create|query|list.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Chat Skill — 临时会话管理

管理 Bot 创建的飞书讨论群：创建、查询、列表、解散。所有映射存储在 `workspace/bot-chat-mapping.json`（BotChatMappingStore）。

**适用于**: 创建讨论群、查询会话、列出现有群、解散群 | **不适用于**: 发送消息（使用 MCP send_text/send_interactive）、PR 审查（使用 pr-scanner）

## Sub-commands

| Command | Description |
|---------|-------------|
| `/chat create` | 创建讨论群并写入映射表 |
| `/chat list` | 列出所有 Bot 创建的群 |
| `/chat query <key>` | 查询特定讨论群信息 |
| `/chat dissolve <chatId>` | 半手动解散群并清理映射表 |

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

- **Key**: `{purpose}-{identifier}`（如 `discussion-1714800000`、`pr-123`）
- **值**: `{ chatId, createdAt, purpose }`

## `/chat create` — 创建讨论群

### 执行步骤

1. **确定参数**: 主题名称（必填）、描述（可选）、参与者 openId 列表（可选）
2. **生成 key**: `discussion-{Date.now()}` 或用户指定标识符
3. **检查是否已存在**:
   ```bash
   cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
   ```
   如果 key 已存在，告知用户该讨论群已创建，返回 chatId。
4. **创建群**:
   ```bash
   lark-cli im chat create --name "{主题名称}" --description "{描述}"
   ```
   从输出中提取 chatId（`oc_` 前缀）。
5. **写入映射表**: 读取当前映射表 JSON，追加新条目，原子写入：
   ```json
   "discussion-{timestamp}": {
     "chatId": "oc_xxx",
     "createdAt": "2026-05-15T00:00:00.000Z",
     "purpose": "discussion"
   }
   ```
6. **发送 context 消息**（可选）: 通过 MCP `send_text` 或 `send_interactive` 向新建群发送上下文信息。
7. **返回结果**: 告知用户创建成功，包含 chatId 和 key。

### 注意事项

- 群名最多 64 字符，超长时截断（注意中文字符）
- `lark-cli im chat create` 失败时记录错误，不写入映射表
- 映射表写入失败时记录错误（可通过群名重建）

## `/chat list` — 列出所有 Bot 创建的群

### 执行步骤

1. **读取映射表**:
   ```bash
   cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
   ```
2. **展示结果**: 以表格形式展示所有条目：

   | Key | Chat ID | Purpose | Created |
   |-----|---------|---------|---------|

3. **为空时**: 提示用户暂无 Bot 创建的群。

### 可选过滤

- `/chat list --purpose discussion` — 仅展示讨论群
- `/chat list --purpose pr-review` — 仅展示 PR 审查群

## `/chat query <key>` — 查询特定讨论群

### 执行步骤

1. **读取映射表**:
   ```bash
   cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
   ```
2. **查找 key**: 在 JSON 中查找 `{key}` 对应的条目。
3. **展示结果**: 显示 chatId、purpose、createdAt。
4. **未找到时**: 提示用户该 key 不存在，建议使用 `/chat list` 查看所有条目。

## `/chat dissolve <chatId>` — 解散群

### 执行步骤

1. **确认操作**: 向用户确认是否要解散群 `{chatId}`（避免误操作）。
2. **查找映射**: 在 `bot-chat-mapping.json` 中查找该 chatId 对应的条目。
3. **解散群**:
   ```bash
   lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
   ```
4. **清理映射表**: 从 JSON 中删除对应条目，原子写入。
5. **通知完成**: 告知用户群已解散，映射已清理。

### 注意事项

- 必须经过用户确认，不自动解散
- `lark-cli` 删除失败时不清理映射表（群可能仍然存在）
- 映射表清理失败时记录错误

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| 映射文件不存在 | 视为空映射表 |
| 映射文件 JSON 无效 | 报错提示，不自动覆盖 |
| `lark-cli` 命令失败 | 记录错误，跳过/退出 |
| 映射文件写入失败 | 记录错误（可通过群名重建） |

## 设计原则

1. **映射表是缓存** — 可从飞书 API 重建
2. **用户驱动解散** — Bot 不自主解散群
3. **幂等操作** — 映射表过滤防重复创建
4. **纯 SKILL.md** — 无 TypeScript 代码，Agent 通过 Bash + MCP 执行

## lark-cli 命令参考

```bash
# 创建群
lark-cli im chat create --name "讨论主题" --description "描述"

# 解散群
lark-cli api DELETE /open-apis/im/v1/chats/oc_xxx

# 查询群列表（用于重建映射）
lark-cli im chats list --as bot
```

## 依赖

`lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore） · MCP `send_text` / `send_interactive`

## 关联

- Parent: #631
- Infrastructure: #2947 (BotChatMappingStore), #2946 (移除 register_temp_chat)
- Reference: `skills/pr-scanner/SKILL.md` (纯 SKILL.md 模式)
