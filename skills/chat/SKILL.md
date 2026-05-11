---
name: chat
description: Temporary chat lifecycle management - create, query, list, and dissolve temporary discussion groups. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理". Also supports direct user invocation via /chat create|query|list|dissolve.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Chat — 临时讨论群管理

按需创建飞书讨论群，通过映射表追踪，支持查询、列表、半手动解散。

**适用于**: 创建讨论群、查询群信息、列出所有群、解散群 ｜ **不适用于**: 发卡片消息、管理群成员

## Commands

| Command | Description |
|---------|-------------|
| `/chat create` | 创建讨论群并写入映射表 |
| `/chat list` | 列出所有 Bot 创建的讨论群 |
| `/chat query <key>` | 查询特定讨论群信息 |
| `/chat dissolve <key>` | 半手动解散群并清理映射表 |

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

- **Key**: `discussion-{timestamp}` → `purposeFromKey()` 推断 purpose
- **Value**: `{ chatId, createdAt, purpose: "discussion" }`

## 执行步骤

### `/chat create` — 创建讨论群

**触发**: 用户或 Agent 主动发起讨论

1. 确定讨论主题和描述（如用户未提供，询问或从上下文推断）
2. 生成 key: `discussion-{Math.floor(Date.now()/1000)}`
3. 创建群:
   ```bash
   lark-cli im chat create --name "讨论 · {主题前25字}" --description "{主题描述}"
   ```
   从输出中提取 chatId（`oc_xxx` 格式）
4. 写入映射表: 读取 `workspace/bot-chat-mapping.json`，追加 `{key}: { chatId, createdAt: new Date().toISOString(), purpose: "discussion" }`，原子写入
5. 通过 MCP `send_text` 发送上下文消息到新群（如需）
6. 向用户报告创建结果（群名、chatId）

### `/chat list` — 列出所有讨论群

1. 读取 `workspace/bot-chat-mapping.json`，文件不存在视为空表
2. 过滤 `purpose: "discussion"` 的条目
3. 格式化输出（key、群名/chatId、创建时间）
4. 无条目时提示"当前无活跃讨论群"

### `/chat query <key>` — 查询特定讨论群

1. 读取 `workspace/bot-chat-mapping.json`
2. 查找指定 key 的条目
3. 展示: key、chatId、purpose、createdAt
4. 不存在时提示"未找到该讨论群"

### `/chat dissolve` — 半手动解散群

**触发**: 用户主动请求（说"解散群"或通过命令）

1. **确认操作**: 向用户确认要解散哪个群（提供 key 或 chatId），避免误操作
2. 获取 chatId: 从映射表中查找对应条目
3. 解散群:
   ```bash
   lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
   ```
4. 清理映射表: 删除 `workspace/bot-chat-mapping.json` 中对应 key 的条目
5. 通知用户解散完成

## 错误处理

- `lark-cli` 命令失败 → 记录错误，报告给用户
- 映射文件读取失败 → 视为空表（创建操作）/ 提示错误（查询操作）
- 映射文件写入失败 → 记录错误，可通过群名重建
- 群不存在（解散时） → 清理映射表中的条目，报告给用户

## 设计原则

1. **纯 SKILL.md** — 零 TypeScript 代码，Agent 通过 lark-cli 和文件操作完成
2. **复用 BotChatMappingStore** — 统一的 `bot-chat-mapping.json`，purpose 字段为 `"discussion"`
3. **用户驱动解散** — Agent 不自主解散群，需用户明确触发
4. **幂等操作** — 映射表过滤防重复创建，解散已删除的条目安全
5. **key 规范** — 使用 `discussion-{timestamp}` 格式，便于 `purposeFromKey()` 推断 purpose

## 依赖

`lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）

## 关联

- Parent: #631
- 基础设施: #2945, #2947, #2946
- 参考: `skills/pr-scanner/SKILL.md` 的纯 SKILL.md 模式
