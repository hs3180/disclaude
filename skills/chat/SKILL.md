---
name: chat
description: Temporary chat lifecycle management - create, query, list, and respond to temporary chats. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理". Also supports direct user invocation via /chat create|query|list.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Chat Skill — 映射表驱动的临时群管理

通过 BotChatMappingStore (`workspace/bot-chat-mapping.json`) 管理临时讨论群的完整生命周期：创建、查询、列表、解散。

**适用于**: 创建讨论群、查询群信息、列出所有群、解散群 ｜ **不适用于**: 发卡片消息（用 MCP send_text/send_interactive）、重命名群（用 rename-group skill）

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{topic}` | create 时必需 | — | 讨论主题（用于群名和映射 key） |
| `{chatId}` | dissolve/query 时必需 | — | 目标群的 Feishu chatId (oc_xxx) |

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

```json
{
  "discussion-{timestamp}": {
    "chatId": "oc_xxx",
    "purpose": "discussion",
    "createdAt": "2026-05-12T11:00:00.000Z"
  }
}
```

- **Key**: `discussion-{timestamp}` — 使用当前时间戳确保唯一性
- **purpose**: `"discussion"` — 区别于 PR Scanner 的 `"pr-review"`

## 子命令

### `/chat create` — 创建讨论群

```
1. 确定讨论主题 {topic}
2. 创建群:
   lark-cli im chat create --name "{topic}" --description "讨论群: {topic}"
3. 从输出中提取 chatId (oc_xxx 格式)
4. 生成 key: discussion-{当前时间戳(秒)}
5. 读取 workspace/bot-chat-mapping.json
6. 追加新条目，原子写入:
   {
     "discussion-{ts}": {
       "chatId": "oc_xxx",
       "purpose": "discussion",
       "createdAt": "{ISO timestamp}"
     }
   }
7. 通过 MCP send_text/send_interactive 向群内发送上下文消息（如需）
8. 返回 chatId 和映射 key 给调用方
```

**群名规则**:
- 由调用方（Agent 或用户）指定
- 最长 64 字符，超出自动截断
- 格式建议: 简洁描述讨论主题

### `/chat dissolve` — 解散讨论群

```
1. 确认操作 — 必须先向用户确认（避免误操作）:
   "确认解散群 {chatId}？此操作不可恢复。"
2. 用户确认后执行:
   lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
3. 从 workspace/bot-chat-mapping.json 中删除对应条目
4. 通知用户解散完成
```

**安全约束**:
- 必须先确认，用户明确同意后才执行删除
- 仅删除 purpose 为 discussion 的条目（保护 pr-review 等其他类型）

### `/chat list` — 列出所有 Bot 创建的群

```
1. 读取 workspace/bot-chat-mapping.json
2. 展示所有条目，格式:

   | Key | Chat ID | Purpose | Created At |
   |-----|---------|---------|------------|
   | discussion-1715... | oc_xxx | discussion | 2026-05-12 |
```

文件不存在或为空时，提示 "暂无群映射记录"。

### `/chat query <key>` — 查询特定讨论群

```
1. 读取 workspace/bot-chat-mapping.json
2. 查找指定 key 的条目
3. 展示详情: key, chatId, purpose, createdAt
4. 未找到则提示 "未找到 key 为 '{key}' 的映射记录"
```

## lark-cli 命令参考

```bash
# 创建群
lark-cli im chat create --name "讨论主题" --description "描述"

# 解散群
lark-cli api DELETE /open-apis/im/v1/chats/oc_xxx

# 查询群列表（用于重建映射）
lark-cli im chats list --as bot
```

## 映射文件操作

映射文件路径: `workspace/bot-chat-mapping.json`

```bash
# 读取映射
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"

# 写入映射 — 先读取，修改，再原子写入（写临时文件后 rename）
```

写入时使用原子操作（写 `.tmp` 文件后 `mv`），避免并发写入损坏。

## 错误处理

| 场景 | 处理 |
|------|------|
| 映射文件不存在 | 视为空映射 `{}` |
| 映射文件 JSON 无效 | 报错，提示映射文件损坏 |
| lark-cli 不可用 | 报错，提示检查 lark-cli 安装 |
| 群创建失败 | 报错，不写入映射 |
| 群解散失败 | 报错，不删除映射条目 |
| key 不存在 (query) | 提示未找到 |

## 设计原则

1. **纯 SKILL.md** — 零 TypeScript 代码，Agent 通过指令直接操作
2. **复用 BotChatMappingStore** — 统一映射表，不引入新的存储机制
3. **用户驱动解散** — Agent 不自主解散群，必须用户确认
4. **幂等操作** — 映射表 key 过滤防重复创建
5. **映射表是缓存** — 可从飞书 API 重建（`lark-cli im chats list --as bot`）

## 依赖

`lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）· MCP 消息工具 (send_text/send_interactive)

## 关联

- Parent: #631
- 基础设施: #2945, #2947, #2946
- 参考: PR Scanner (`skills/pr-scanner/SKILL.md`) 的纯 SKILL.md 模式
- 替代: PR #3260（被拒绝 — 使用了 TypeScript + ChatStore，过度设计）
- Issue: #3283
