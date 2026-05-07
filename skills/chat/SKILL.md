---
name: chat
description: Temporary chat lifecycle management - create, query, list, and respond to temporary chats. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理". Also supports direct user invocation via /chat create|query|list.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Chat — 通用讨论群管理

管理 Bot 创建的飞书讨论群：创建、解散、查询、列表。

**适用于**: 按需创建讨论群、解散群、查询群信息 ｜ **不适用于**: PR 场景的群（由 PR Scanner 管理）、发消息（用 MCP send_text/send_interactive）

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{topic}` | Yes (create) | — | 讨论主题/标题 |
| `{description}` | No | — | 群描述 |
| `{key}` | Yes (query/dissolve) | — | 映射表中的 key（如 `discussion-1714800000`） |

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

- **Key**: `discussion-{timestamp}` → `purposeFromKey()` 推断 purpose 为 `discussion`
- **群名**: 用户指定的 `{topic}`

## 执行步骤

### `/chat create` — 创建讨论群

```
1. 确定讨论主题（{topic}），生成 key: discussion-{Date.now()}
2. 创建群:
   lark-cli im chat create --name "{topic}" --description "{description 或 '讨论群'}"
3. 从输出中提取 chatId（oc_xxx 格式）
4. 写入映射表:
   读取 workspace/bot-chat-mapping.json（不存在视为 {}）
   追加条目:
   {
     "discussion-{timestamp}": {
       "chatId": "oc_xxx",
       "purpose": "discussion",
       "createdAt": "<ISO timestamp>"
     }
   }
   原子写入（写临时文件 → rename）
5. 通过 MCP send_text 或 send_interactive 发送初始上下文消息到新群（可选，由调用方决定）
6. 返回结果: key, chatId
```

**映射表写入示例**:

```bash
# 读取现有映射
MAPPING=$(cat workspace/bot-chat-mapping.json 2>/dev/null || echo '{}')

# 使用 node 追加条目并原子写入
node -e "
const fs = require('fs');
const key = 'discussion-' + Date.now();
const mapping = JSON.parse(fs.readFileSync('workspace/bot-chat-mapping.json', 'utf-8').trim() || '{}');
mapping[key] = {
  chatId: process.argv[1],
  purpose: 'discussion',
  createdAt: new Date().toISOString()
};
const tmp = 'workspace/bot-chat-mapping.json.' + Date.now() + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(mapping, null, 2) + '\n');
fs.renameSync(tmp, 'workspace/bot-chat-mapping.json');
console.log('Written key:', key);
" "oc_xxx"
```

### `/chat dissolve` — 半手动解散群

```
1. 用户触发（说「解散群」或点击按钮）或 Agent 判断需要解散
2. 确认目标群: 提供 key 或 chatId
3. 用户确认（避免误操作）— 如果是用户主动触发的可以跳过确认
4. 读取映射表，查找对应条目
5. 解散群:
   lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
6. 删除映射表中的条目:
   读取 → 删除 key → 原子写回
7. 通知用户解散完成
```

**映射表条目删除示例**:

```bash
node -e "
const fs = require('fs');
const key = process.argv[1];
const mapping = JSON.parse(fs.readFileSync('workspace/bot-chat-mapping.json', 'utf-8').trim() || '{}');
if (!(key in mapping)) {
  console.error('Key not found:', key);
  process.exit(1);
}
delete mapping[key];
const tmp = 'workspace/bot-chat-mapping.json.' + Date.now() + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(mapping, null, 2) + '\n');
fs.renameSync(tmp, 'workspace/bot-chat-mapping.json');
console.log('Deleted key:', key);
" "discussion-1714800000"
```

### `/chat list` — 列出所有 Bot 创建的讨论群

```
1. 读取 workspace/bot-chat-mapping.json
2. 筛选 purpose === 'discussion' 的条目
3. 格式化展示:
   | Key | Chat ID | Created At |
   | discussion-1714800000 | oc_xxx | 2024-05-04T... |
4. 如无条目，告知用户当前无讨论群
```

**列出示例**:

```bash
node -e "
const fs = require('fs');
const data = fs.readFileSync('workspace/bot-chat-mapping.json', 'utf-8').trim() || '{}';
const mapping = JSON.parse(data);
const discussions = Object.entries(mapping).filter(([, v]) => v.purpose === 'discussion');
if (discussions.length === 0) {
  console.log('当前无讨论群');
} else {
  discussions.forEach(([key, entry]) => {
    console.log(key + ' | ' + entry.chatId + ' | ' + entry.createdAt);
  });
}
"
```

### `/chat query <key>` — 查询特定讨论群

```
1. 读取 workspace/bot-chat-mapping.json
2. 查找指定 key 的条目
3. 返回完整信息: key, chatId, purpose, createdAt
4. 如果 key 不存在，提示用户并建议 /chat list 查看所有群
```

**查询单条示例**:

```bash
node -e "
const fs = require('fs');
const key = process.argv[1];
const data = fs.readFileSync('workspace/bot-chat-mapping.json', 'utf-8').trim() || '{}';
const mapping = JSON.parse(data);
if (key in mapping) {
  const entry = mapping[key];
  console.log(JSON.stringify({ key, ...entry }, null, 2));
} else {
  console.error('Key not found:', key);
  console.error('Use /chat list to see all discussion groups');
  process.exit(1);
}
" "discussion-1714800000"
```

## lark-cli 命令参考

```bash
# 创建群
lark-cli im chat create --name "讨论主题" --description "描述"

# 解散群
lark-cli api DELETE /open-apis/im/v1/chats/{chatId}

# 查询群列表（用于重建映射）
lark-cli im chats list --as bot
```

## 映射表格式

```json
{
  "pr-123": { "chatId": "oc_xxx", "purpose": "pr-review", "createdAt": "..." },
  "discussion-1714800000": { "chatId": "oc_yyy", "purpose": "discussion", "createdAt": "..." },
  "feedback-456": { "chatId": "oc_zzz", "purpose": "feedback", "createdAt": "..." }
}
```

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| 映射文件不存在 | 视为空映射表 `{}`，创建时自动创建文件 |
| 映射文件 JSON 解析失败 | 告知用户映射表损坏，建议备份后重建 |
| `lark-cli` 命令失败 | 记录错误，不写入映射表（create）或不删除映射表（dissolve） |
| Key 不存在（query/dissolve） | 提示用户，建议 /chat list 查看所有群 |
| 群创建失败 | 跳过写入映射表，告知用户失败原因 |
| 映射文件写入失败 | 记录错误，可通过群名重建映射 |

## 设计原则

1. **纯 SKILL.md** — 零 TypeScript 代码，Agent 通过 Bash 执行
2. **映射表是缓存** — 可从飞书 API 重建
3. **用户驱动解散** — 不做自动解散，无 TTL、无状态机
4. **复用 BotChatMappingStore** — 统一的映射表，不引入新的存储机制
5. **幂等操作** — 映射表过滤防重复创建
6. **与 PR Scanner 共存** — `purpose` 字段区分不同用途的群

## 依赖

`lark-cli` · `node` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）

## 关联

- Parent: #631
- 基础设施: #2945, #2947, #2946
- 参考: PR Scanner (`skills/pr-scanner/SKILL.md`) 的纯 SKILL.md 模式
- Supersedes: PR #3260（过度设计，TypeScript 包装 + ChatStore 第二套存储）
