---
name: chat
description: Temporary chat lifecycle management - create, query, list, and respond to temporary chats. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理". Also supports direct user invocation via /chat create|query|list.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Chat — 通用建群 Skill

管理飞书临时讨论群的生命周期：创建、查询、列表、解散。通过 `lark-cli` 执行群操作，通过 `BotChatMappingStore` 维护映射表。

**适用于**: 创建讨论群、查询群信息、列表所有群、解散群 ｜ **不适用于**: 发卡片消息、发送文本、自动定时解散

## 设计原则

1. **纯 SKILL.md** — 零 TypeScript 代码，Agent 通过 Bash 直接调用 `lark-cli`
2. **复用 BotChatMappingStore** — 统一的映射表 `workspace/bot-chat-mapping.json`，不引入新的存储机制
3. **用户驱动解散** — Bot 不自主解散群，必须用户明确触发
4. **幂等操作** — 映射表过滤防止重复创建

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

- **Key**: `discussion-{timestamp}` → `purposeFromKey()` 推断 purpose 为 `discussion`
- **Value**: `{ chatId: "oc_xxx", createdAt: "ISO时间", purpose: "discussion" }`

## 命令

### `/chat create` — 创建讨论群

**触发**: 用户说「创建群」「建群」「发起讨论」「创建临时会话」，或 Agent 工作流需要按需建群。

**执行步骤**:

1. 确定讨论主题和描述
2. 创建群:
   ```bash
   lark-cli im chat create --name "{主题}" --description "{描述}"
   ```
3. 写入映射表:
   - Key: `discussion-{当前时间戳（秒）}`
   - 读取 `workspace/bot-chat-mapping.json`，追加条目，原子写入
   - 条目格式: `"discussion-{timestamp}": { "chatId": "oc_xxx", "createdAt": "ISO时间", "purpose": "discussion" }`
4. 通过 MCP `send_text` 或 `send_interactive` 向群内发送上下文消息（如需要）
5. 返回创建结果给用户

**参数**:

| 参数 | 必填 | 说明 |
|------|------|------|
| 主题 | 是 | 群名称（最长 64 字符，超出自动截断） |
| 描述 | 否 | 群描述 |
| 用户列表 | 否 | 群成员（`ou_xxx` 格式），为空则仅 Bot |

**示例**:
```bash
# 创建群
lark-cli im chat create --name "需求评审讨论" --description "关于新功能的需求评审"

# 返回 chatId 后写入映射
# Key: discussion-1746057600
# Purpose: discussion
```

### `/chat dissolve` — 解散讨论群

**触发**: 用户说「解散群」「删除群」「关闭讨论」。

**⚠️ 安全确认**: 执行前必须向用户确认，避免误操作。

**执行步骤**:

1. 用户触发解散请求
2. 向用户确认: 「确认要解散群 [{群名}] 吗？此操作不可撤销。」
3. 用户确认后执行:
   ```bash
   lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
   ```
4. 删除映射表中的条目:
   - 读取 `workspace/bot-chat-mapping.json`
   - 删除对应 key 的条目
   - 原子写入
5. 通知用户解散完成

**参数**:

| 参数 | 必填 | 说明 |
|------|------|------|
| chatId 或 key | 是 | 群 ID (oc_xxx) 或映射表 key (discussion-xxx) |

### `/chat list` — 列出所有讨论群

**触发**: 用户说「列出群」「查看所有群」「群列表」。

**执行步骤**:

1. 读取 `workspace/bot-chat-mapping.json`
2. 展示所有条目（或按 purpose 过滤）
3. 格式化为可读列表返回给用户

**参数**:

| 参数 | 必填 | 说明 |
|------|------|------|
| purpose | 否 | 按用途过滤，如 `discussion`、`pr-review`，为空则显示全部 |

**输出格式**:
```
📋 讨论群列表 (共 N 个):
1. discussion-1746057600 — oc_xxx — 需求评审讨论 — 创建于 2026-05-01
2. discussion-1746144000 — oc_yyy — 技术方案讨论 — 创建于 2026-05-02
```

### `/chat query` — 查询特定讨论群

**触发**: 用户说「查询群」「查看群信息」。

**执行步骤**:

1. 读取 `workspace/bot-chat-mapping.json`
2. 根据 key 查找对应条目
3. 返回详细信息

**参数**:

| 参数 | 必填 | 说明 |
|------|------|------|
| key | 是 | 映射表中的 key（如 `discussion-1746057600`） |

**输出格式**:
```
📋 群信息:
- Key: discussion-1746057600
- Chat ID: oc_xxx
- 用途: discussion
- 创建时间: 2026-05-01T10:00:00Z
```

## 映射表操作参考

### 读取映射表
```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

### 追加条目（原子写入）
```bash
# 读取 → 解析 → 追加 → 写入
node -e '
const fs = require("fs");
const f = "workspace/bot-chat-mapping.json";
let data = {};
try { data = JSON.parse(fs.readFileSync(f, "utf-8")); } catch {}
const key = "discussion-" + Math.floor(Date.now() / 1000);
data[key] = { chatId: process.argv[1], createdAt: new Date().toISOString(), purpose: "discussion" };
const tmp = f + "." + Date.now() + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
fs.renameSync(tmp, f);
console.log("✅ 写入成功: " + key);
' "oc_CHAT_ID_HERE"
```

### 删除条目
```bash
node -e '
const fs = require("fs");
const f = "workspace/bot-chat-mapping.json";
const key = process.argv[1];
let data = {};
try { data = JSON.parse(fs.readFileSync(f, "utf-8")); } catch {}
if (!data[key]) { console.log("⚠️ 条目不存在: " + key); process.exit(0); }
delete data[key];
const tmp = f + "." + Date.now() + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
fs.renameSync(tmp, f);
console.log("✅ 已删除: " + key);
' "discussion-KEY_HERE"
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 映射文件不存在 | 视为空映射表 `{}` |
| 映射文件 JSON 格式错误 | 视为空映射表，记录警告 |
| `lark-cli` 创建群失败 | 返回错误信息，不写入映射 |
| `lark-cli` 解散群失败 | 返回错误信息，保留映射条目（供重试） |
| 映射写入失败 | 返回错误信息（可通过群名重建映射） |
| 解散时群不存在（已被手动解散） | 删除映射条目，通知用户 |

## lark-cli 命令参考

```bash
# 创建群
lark-cli im chat create --name "讨论主题" --description "描述"

# 解散群
lark-cli api DELETE /open-apis/im/v1/chats/oc_xxx

# 查询 Bot 创建的所有群
lark-cli im chats list --as bot
```

## 依赖

`lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）

## 关联

- Parent: #631
- 基础设施: #2945, #2947, #2946
- 参考: `skills/pr-scanner/SKILL.md`（PR Scanner 的纯 SKILL.md 模式）
