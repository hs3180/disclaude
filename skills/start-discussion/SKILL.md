---
name: start-discussion
description: Initiate a non-blocking discussion by creating a Feishu group, sending context, and recording the mapping. Use when the agent identifies a topic needing deeper discussion with the user, wants to delegate an offline question, or needs to spawn a sub-agent conversation without blocking current work. Keywords: 'start discussion', '发起讨论', '创建讨论群', '离线提问', 'offline question', 'start-discussion', '非阻塞讨论'.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, mcp__channel-mcp__*
---

# Start Discussion — 非阻塞离线讨论

创建飞书群聊并发送讨论上下文，不阻塞当前 Agent 工作。

**适用于**: 发起讨论、离线提问、委派子任务 ｜ **不适用于**: 投票、PR Review、定时任务

## When to Use

**Use this skill for:**
- Agent 需要向用户提问但不阻塞当前工作
- 需要针对某个话题发起多人讨论
- 需要将子任务委派给其他 ChatAgent
- 检测到重复问题，想发起改善讨论

**Keywords**: "start discussion", "发起讨论", "离线提问", "offline question", "非阻塞", "创建讨论群"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)
- **Message ID**: Message ID (from "**Message ID:** xxx")

## Single Responsibility

- ✅ 创建飞书群聊（via lark-cli）
- ✅ 发送讨论上下文到群聊（via MCP tools）
- ✅ 记录映射到 bot-chat-mapping.json
- ✅ 立即返回，不等待回复
- ❌ DO NOT 等待群聊回复
- ❌ DO NOT 解散群聊（由 chat-timeout skill 处理）
- ❌ DO NOT 使用 IPC Channel 进行群组操作

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| topic | Yes | — | 讨论主题（简短描述，≤30字） |
| context | Yes | — | 发送给讨论群的上下文内容 |
| members | No | — | 群成员 open_id 列表（逗号分隔，如 `ou_aaa,ou_bbb`） |

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

- **Key**: `discussion-{timestamp}` → `purposeFromKey()` 推断 purpose = `discussion`
- **群名**: `讨论 · {topic前30字}`
- **Purpose**: `discussion`

## 执行步骤

### 1. 检查 lark-cli 可用性

```bash
lark-cli --version
```

如果命令失败，输出错误并终止：`lark-cli not found. Install: npm install -g @larksuite/cli`

### 2. 生成映射 Key

使用当前时间戳生成唯一 key：

```bash
echo "discussion-$(date +%s)"
```

记下此 key，后续步骤需要使用。

### 3. 读取现有映射

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo '{}"
```

检查是否已有相同 topic 的讨论群。如果 `purpose: 'discussion'` 的条目中 topic 匹配（通过群名比对），可复用该群。

### 4. 创建飞书群聊

```bash
lark-cli im chat create \
  --name "讨论 · {topic}" \
  --description "离线讨论: {topic}"
```

如果需要添加成员（members 参数非空）：

```bash
lark-cli im chat create \
  --name "讨论 · {topic}" \
  --description "离线讨论: {topic}" \
  --users "{members}"
```

从输出中提取 `chatId`（格式为 `oc_xxx`）。

**注意**: 如果 lark-cli 输出包含 JSON，使用 `--output json` 或解析输出提取 chatId。

### 5. 发送讨论上下文

使用 MCP 工具向新创建的群发送上下文消息：

**使用 send_card（推荐）**:
```
mcp__channel-mcp__send_card({
  card: {
    config: { wide_screen_mode: true },
    header: {
      title: { content: "讨论: {topic}", tag: "plain_text" },
      template: "blue"
    },
    elements: [
      { tag: "markdown", content: "{context}" }
    ]
  },
  chatId: "{chatId from step 4}"
})
```

**或使用 send_text（简单场景）**:
```
mcp__channel-mcp__send_text({
  text: "📋 **讨论: {topic}**\n\n{context}",
  chatId: "{chatId from step 4}"
})
```

### 6. 记录映射

将新群信息写入映射文件。读取现有文件，追加条目，原子写入：

```json
{
  "discussion-{timestamp}": {
    "chatId": "{chatId from step 4}",
    "createdAt": "{ISO timestamp}",
    "purpose": "discussion"
  }
}
```

### 7. 返回结果

立即返回，告知调用方讨论已创建：

```
✅ 讨论群已创建
- Topic: {topic}
- Chat ID: {chatId}
- Mapping Key: discussion-{timestamp}
- Members: {members or '仅 Bot'}

ChatAgent 将在群内响应用户消息。
```

## 解散讨论群

讨论完成后（由 chat-timeout skill 触发或手动操作），使用以下命令解散：

```bash
lark-cli api DELETE /open-apis/im/v1/chats/{chatId}
```

然后从映射文件中删除对应条目。

## 错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| lark-cli 不可用 | 输出安装提示，终止 |
| 群创建失败 | 记录错误，不写入映射 |
| 消息发送失败 | 记录错误（群已创建，映射已写入） |
| 映射文件读写失败 | 记录错误（可通过群名重建） |

## 设计原则

1. **非阻塞** — 创建群 + 发消息后立即返回
2. **lark-cli 直调** — 群操作通过 Bash 调用 lark-cli，不经过 IPC Channel
3. **映射表是缓存** — 可从飞书 API 重建（discussion 条目不可自动重建，需手动维护）
4. **幂等操作** — 映射表过滤防重复创建（同 topic 同群）

## 依赖

`lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore） · MCP channel tools

## 关联

- Issue: #631 (离线提问)
- 相关 Skill: `chat-timeout` (超时解散), `pr-scanner` (参考实现)
- Infrastructure: #2947 (BotChatMappingStore)
