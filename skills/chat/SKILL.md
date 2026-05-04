---
name: chat
description: Temporary chat lifecycle management - create, query, list, and respond to temporary chats. Primarily invoked by agents (PR Scanner, offline questions, etc.) to initiate user interactions. Use when user says keywords like "临时会话", "创建临时会话", "temporary chat", "/chat create", "发起讨论", "会话管理". Also supports direct user invocation via /chat create|query|list.
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep]
---

# Chat Skill — 通用讨论群管理

通过 `lark-cli` 和映射表管理飞书临时讨论群的全生命周期。

**适用于**: 创建讨论群、解散群、查询群列表 ｜ **不适用于**: 发送消息（使用 MCP 工具）、自动过期

## 核心原则

1. **纯 SKILL.md** — 无 TypeScript 代码，Agent 直接通过 Bash 操作
2. **复用 BotChatMappingStore** — 统一的 `workspace/bot-chat-mapping.json`，支持任意 purpose
3. **不自动解散** — 仅在用户主动触发时执行解散
4. **不引入 ChatStore** — 无 TTL、无状态机、无自动过期

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`

```json
{
  "discussion-1714800000": {
    "chatId": "oc_xxx",
    "purpose": "discussion",
    "createdAt": "2026-05-04T08:00:00.000Z"
  }
}
```

**Key 格式**: `discussion-{timestamp}` — `purposeFromKey()` 推断 purpose 为 `discussion`

## 子命令

### `/chat create` — 创建讨论群

#### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| 主题/名称 | 是 | 群名称，最多 64 字符（CJK 安全截断） |
| 描述 | 否 | 群描述，说明讨论目的 |
| 参与者 | 否 | 用户 open_id 列表（`ou_xxx` 格式） |

#### 执行步骤

**1. 生成映射 key**

使用当前 Unix 时间戳: `discussion-{Math.floor(Date.now()/1000)}`

**2. 截断群名**

群名超过 64 字符时，按字符边界截断（CJK 安全）:
```bash
# 使用 Array.from 截断（在 Node 中）
node -e "console.log(Array.from('${NAME}').slice(0, 64).join(''))"
```

**3. 创建群**

```bash
lark-cli im chat create --name "讨论主题" --description "描述内容"
```

解析输出获取 `chatId`（`oc_xxx` 格式）。

**4. 添加成员（如有）**

```bash
lark-cli im chat add-member --chat-id oc_xxx --members ou_aaa,ou_bbb
```

**5. 写入映射表**

读取 `workspace/bot-chat-mapping.json`，追加条目，原子写入:

```bash
# 读取现有映射
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

使用 Edit 工具将新条目添加到 JSON:
```json
"discussion-{timestamp}": {
  "chatId": "oc_xxx",
  "purpose": "discussion",
  "createdAt": "2026-05-04T08:00:00.000Z"
}
```

**6. 发送 context 消息（可选）**

使用 MCP 工具 `send_text` 或 `send_interactive` 向新群发送上下文消息。告知参与者讨论主题和背景。

**7. 返回结果**

```
✅ 讨论群已创建

群名: {name}
Chat ID: oc_xxx
映射 key: discussion-{timestamp}
参与者: {members 或 "无"}
```

---

### `/chat dissolve` — 解散讨论群

#### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| chatId 或 key | 是 | 群 chatId（`oc_xxx`）或映射 key（`discussion-xxx`） |

#### 执行步骤

**1. 确认操作**

⚠️ 必须向用户确认后才执行解散。发送确认卡片:

```
⚠️ 确认要解散该讨论群吗？此操作不可撤销。

群名: {name}
Chat ID: oc_xxx
```

等待用户确认后才继续。

**2. 查找映射条目**

如果传入 key，从映射表查找 chatId:
```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

如果传入 chatId，遍历映射表找到对应条目的 key。

**3. 解散群**

```bash
lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
```

**4. 清理映射表**

使用 Edit 工具从 `workspace/bot-chat-mapping.json` 中删除对应条目。

**5. 返回结果**

```
✅ 讨论群已解散

Chat ID: oc_xxx
映射 key: discussion-{timestamp}
```

---

### `/chat list` — 列出所有讨论群

#### 执行步骤

**1. 读取映射表**

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

**2. 过滤 discussion 条目**

筛选 `purpose === "discussion"` 的条目。

**3. 格式化输出**

| Key | Chat ID | 创建时间 |
|-----|---------|----------|
| discussion-1714800000 | oc_xxx | 2026-05-04 |

如果没有条目，返回: `📭 暂无讨论群`

---

### `/chat query <key>` — 查询特定讨论群

#### 执行步骤

**1. 读取映射表**

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

**2. 查找条目**

按 key 查找，支持精确匹配和前缀匹配。

**3. 返回结果**

找到时:
```
🔍 映射条目: discussion-{timestamp}
Chat ID: oc_xxx
Purpose: discussion
创建时间: 2026-05-04T08:00:00.000Z
```

未找到时: `❌ 未找到 key 为 "{key}" 的讨论群`

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| lark-cli 未安装 | 返回明确错误: "lark-cli 未安装，无法执行群操作" |
| lark-cli 命令失败 | 记录错误信息，告知用户操作失败 |
| 映射文件不存在 | 视为空映射表（`{}`） |
| 映射文件 JSON 格式错误 | 回退到空表，提示用户映射文件损坏 |
| chatId 无效 | 返回错误: "无效的 Chat ID 格式，需要 oc_xxx" |
| 解散不存在的群 | 返回错误但不 crash |
| key 不存在 | 返回 "未找到" 提示 |

## 设计原则

1. **映射表是缓存** — 可从飞书 API 重建
2. **用户驱动解散** — Agent 不自主解散群，必须用户确认
3. **幂等操作** — 映射表过滤防重复，重复创建产生新群
4. **零代码** — 纯 SKILL.md 指导 Agent 行为，无 TypeScript 依赖
5. **统一存储** — 复用 BotChatMappingStore，不引入新的存储机制

## 依赖

- `lark-cli` — 飞书群操作 CLI
- `workspace/bot-chat-mapping.json` — BotChatMappingStore
- MCP 工具 `send_text` / `send_interactive` — 发送消息到群

## 关联

- Parent: #631（离线提问 - 非阻塞交互）
- 基础设施: #2945, #2947 (BotChatMappingStore), #2946
- 参考: PR Scanner (`skills/pr-scanner/SKILL.md`) 的纯 SKILL.md 模式
- Supersedes: PR #3260（过度设计，使用 TypeScript 包装 + ChatStore 第二套存储）

## DO NOT

- ❌ 创建 TypeScript 代码文件 — 本 skill 只需要 SKILL.md
- ❌ 引入 ChatStore 或 TTL 机制 — 不做自动过期
- ❌ 不经确认直接解散群 — 必须用户确认
- ❌ 使用 MCP 工具操作群 — 群操作通过 lark-cli Bash 调用
- ❌ 自行决定何时建群 — 由用户或其他 skill 触发
