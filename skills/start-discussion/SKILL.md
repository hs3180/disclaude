---
name: start-discussion
description: Create a temporary discussion group for a specific topic, deliver context, and return immediately (non-blocking). Use when the agent identifies a discussion-worthy topic from analysis (repetitive issues, complex decisions, user complaints), or when triggered by keywords like "发起讨论", "创建讨论组", "start discussion", "讨论一下", "offline question", "离线提问".
allowed-tools: Read, Write, Edit, Bash, send_text, send_interactive
---

# Start Discussion — 创建话题讨论群

Agent 识别需要深入探讨的话题后，创建飞书讨论群、注入上下文、注册映射，然后立即返回（非阻塞）。

**适用于**: 发起讨论、创建讨论群、注入讨论上下文 | **不适用于**: 解散群、群内交互、执行讨论结论

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{topic}` | Yes | — | Discussion topic (short summary, max 30 chars for group name) |
| `{context}` | Yes | — | Background context to send to the discussion group (analysis, evidence, questions) |
| `{members}` | No | — | Comma-separated Feishu user open_id list to add to the group |

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx" in the message header)
- **Message ID**: Message ID (from "**Message ID:** xxx")

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

- **Key**: `discussion-{timestamp}` → `purposeFromKey()` 推断 purpose 为 `discussion`
- **群名**: `讨论: {topic}`

## 执行步骤

### 1. 生成映射 Key

使用时间戳生成唯一 key：

```bash
echo "discussion-$(date +%s)"
```

记录此 key，后续步骤使用。

### 2. 检查重复讨论

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

检查是否已有相同 topic 的讨论群（遍历 `purpose: 'discussion'` 条目）。如有，跳过创建，直接使用已有 chatId 发送补充上下文。

### 3. 创建飞书讨论群

```bash
lark-cli im chat create --name "讨论: {topic}" --description "自动创建的讨论群 — {topic}"
```

从输出中解析新群 chatId（格式 `oc_xxx`）。

**如果需要添加指定成员**（`{members}` 非空）：

```bash
lark-cli im chat.member create --chat-id {chatId} --member-id-type open_id --user-id {memberId}
```

### 4. 写入映射表

读取 `workspace/bot-chat-mapping.json`，追加条目：

```json
"discussion-{timestamp}": {
  "chatId": "oc_xxx",
  "createdAt": "2026-05-03T01:00:00.000Z",
  "purpose": "discussion"
}
```

原子写入（Read → Edit → Write），确保不覆盖其他条目。

### 5. 发送讨论上下文

使用 `send_text` 向新群发送上下文消息。消息格式：

```
📋 讨论话题: {topic}

{context}

---
此讨论由 Agent 自动创建。请就上述话题展开讨论，讨论结果将用于指导后续行动。
```

**如果需要用户交互式选择**，使用 `send_interactive` 发送带按钮的卡片。

### 6. 通知发起者

向原始 chatId（步骤 1 的上下文 chatId）发送确认消息：

```
✅ 已创建讨论群「讨论: {topic}」，上下文已发送。
```

### 7. 返回

立即返回，不等待讨论结果。讨论群中的 ChatAgent 将自动接管后续交互。

## 错误处理

- `lark-cli` 不可用 → 记录错误，提示用户安装 lark-cli
- 群创建失败 → 记录错误，不写入映射，返回失败信息
- 映射文件写入失败 → 记录错误（群已创建，可手动补充映射）
- 消息发送失败 → 记录错误（群已创建，可重试发送）

## 设计原则

1. **非阻塞** — 创建群 + 发送上下文后立即返回，不等待响应
2. **Skill 编排，非 MCP** — 编排逻辑在 Skill 层，使用原子工具（lark-cli + MCP send_*）
3. **lark-cli 直连** — 群操作通过 Bash 调用 lark-cli，不经 IPC/MCP
4. **映射表是缓存** — 映射文件可从飞书 API 重建（需手动补充 discussion 条目）
5. **幂等操作** — 映射表过滤防重复创建，相同 topic 不重复建群

## 依赖

`lark-cli` · `send_text` MCP tool · `send_interactive` MCP tool · `workspace/bot-chat-mapping.json`（BotChatMappingStore）

## 关联

- Issue: #631
- Depends on: lark-cli availability, BotChatMappingStore (#2947)
- Related: #700 (MVP use case — daily-chat-review triggers discussion), #1228 (discussion focus), #1229 (smart session ending)
