---
name: chat
description: Temporary chat lifecycle management - create, query, list, and respond to temporary chats. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理". Also supports direct user invocation via /chat create|query|list.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Chat — 临时会话生命周期管理

管理 Bot 创建的飞书讨论群：创建、解散、查询、列表。所有群操作通过 `lark-cli` 执行，消息通过 MCP 工具发送。

**适用于**: 创建讨论群、解散群、查询群映射 ｜ **不适用于**: PR Review（用 pr-scanner）、重命名群（用 rename-group）

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{topic}` | create 时 Yes | — | 讨论主题，用作群名的一部分 |
| `{context}` | create 时 No | — | 发送到新群的上下文消息 |
| `{users}` | No | — | 要添加的用户 open_id 列表（逗号分隔，ou_xxx 格式） |
| `{key}` | query/dissolve 时 Yes | — | 映射表中的 key |

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

```jsonc
{
  "discussion-1714800000": {
    "chatId": "oc_xxx",
    "purpose": "discussion",
    "createdAt": "2026-05-16T10:00:00Z"
  }
}
```

- **Key 格式**: `{purpose}-{identifier}`（如 `discussion-1714800000`）
- **purpose**: `discussion`（通用讨论）、`feedback`（反馈）、或自定义类型
- **identifier**: Unix 时间戳或语义化标识符

## 命令

### `/chat create` — 创建讨论群

```
1. 确定讨论主题（{topic}）和可选的参与者（{users}）
2. 生成 key: discussion-{unix_timestamp}
3. 创建群:
   lark-cli im chat create --name "{topic}" --description "{topic} 讨论群"
4. 从命令输出提取 chatId（oc_xxx 格式）
5. 写入映射表（追加条目到 workspace/bot-chat-mapping.json）
6. 如果提供了 {context}，通过 MCP send_text 或 send_interactive 发送到新群
7. 如果提供了 {users}，添加成员:
   lark-cli im chat.members create \
     --params '{"chat_id":"{chatId}","member_id_type":"open_id","succeed_type":1}' \
     --data '{"id_list":["ou_aaa","ou_bbb"]}' --as bot
8. 返回结果: key、chatId、群名
```

**注意事项**:
- 群名超过 64 字符时需截断（CJK 安全，在字符边界截断）
- 群名可含 emoji、中文、英文混合
- 写入映射表时使用原子写入（写临时文件后 rename）
- 如果 lark-cli 未认证，提示用户先完成鉴权，不执行操作

### `/chat dissolve` — 解散讨论群

```
1. 用户触发（说「解散群」或点击按钮）
2. 确认操作: 向用户确认要解散的群（避免误操作）
3. 从映射表读取 chatId:
   cat workspace/bot-chat-mapping.json | jq '.{key}'
4. 解散群:
   lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
5. 删除映射表中的条目（从 workspace/bot-chat-mapping.json 移除 {key}）
6. 通知用户解散完成
```

**注意事项**:
- 解散前必须向用户确认
- chatId 无效时返回明确错误提示
- 解散已被解散的群会报错，但不 crash，需优雅处理
- 解散后其他映射条目不受影响

### `/chat list` — 列出所有讨论群

```
1. 读取映射表:
   cat workspace/bot-chat-mapping.json
2. 展示所有条目，按 createdAt 排序
3. 如果映射表为空，返回空列表提示
```

### `/chat query <key>` — 查询特定讨论群

```
1. 读取映射表:
   cat workspace/bot-chat-mapping.json | jq '.{key}'
2. 存在则返回映射详情（key、chatId、purpose、createdAt）
3. 不存在则返回 not found
```

## 错误处理

- `lark-cli` 命令失败 → 记录错误，向用户报告
- 映射文件读取失败 → 视为空表
- 映射文件写入失败 → 记录错误（可通过群名重建）
- 群创建失败 → 不写入映射表，报告错误
- 群解散失败 → 不删除映射表条目，报告错误
- lark-cli 未安装或未认证 → 提示用户安装/认证

## 设计原则

1. **纯 SKILL.md** — 零 TypeScript 代码，Agent 按指令执行
2. **映射表是缓存** — 可从飞书 API 重建（`lark-cli im chats list --as bot`）
3. **用户驱动解散** — Bot 不自主解散群
4. **幂等操作** — 映射表过滤防重复创建
5. **原子写入** — 映射表更新使用写临时文件后 rename 的方式

## 依赖

`lark-cli` · MCP send_text / send_interactive · `workspace/bot-chat-mapping.json`（BotChatMappingStore）

## 关联

- Parent: #631（离线提问）
- 基础设施: #2945（简化临时会话设计）、#2947（BotChatMappingStore）
- 参考: `skills/pr-scanner/SKILL.md`（纯 SKILL.md 模式）
