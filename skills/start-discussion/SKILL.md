---
name: start-discussion
description: Initiate a non-blocking discussion by creating a Feishu group, sending context, and recording the mapping. Use when the agent identifies a topic needing deeper discussion with the user, wants to delegate an offline question, or needs to spawn a sub-agent conversation without blocking current work. Keywords: 'start discussion', '发起讨论', '创建讨论群', '离线提问', 'offline question', 'start-discussion', '非阻塞讨论'.
allowed-tools: [send_text, send_interactive, Bash]
---

# Start Discussion — 非阻塞讨论发起

针对某个具体问题创建飞书讨论群，发送讨论上下文，立即返回（不阻塞当前工作）。

**适用于**: 发起讨论、离线提问、委托子 Agent 讨论 ｜ **不适用于**: 群组解散、群组重命名、消息回复

## Single Responsibility

- ✅ 创建飞书讨论群（通过 lark-cli）
- ✅ 发送讨论上下文到新群（通过 MCP send_text / send_interactive）
- ✅ 记录 chatId 映射到 bot-chat-mapping.json
- ✅ 非阻塞 — 发送后立即返回
- ❌ DO NOT 等待讨论结果
- ❌ DO NOT 解散群组（由 chat-timeout skill 或用户手动处理）
- ❌ DO NOT 重命名群组（由 rename-group skill 处理）
- ❌ DO NOT 通过 MCP 或 IPC Channel 创建群组

## Context Variables

When invoked, you receive:
- **Chat ID**: Current Feishu chat ID (from `**Chat ID:** xxx` in message header)
- **Message ID**: Current message ID (from `**Message ID:** xxx` in header)

## Workflow

### Step 1: 确定讨论主题和参与者

从当前对话中提取：
- **讨论主题**: 一句话概括需要讨论的问题
- **讨论上下文**: 相关的背景信息（用户之前的对话摘要、相关文件、数据等）
- **参与者**: 需要参与讨论的用户 open_id 列表（如不确定，可不指定，后续通过 lark-cli 添加）

### Step 2: 创建飞书讨论群

```bash
lark-cli im chat create \
  --name "讨论: {主题前30字}" \
  --description "{主题描述}"
```

如果需要指定初始成员：

```bash
lark-cli im chat create \
  --name "讨论: {主题前30字}" \
  --description "{主题描述}" \
  --users "{ou_xxx,ou_yyy}"
```

从输出中提取新群的 `chat_id`（`oc_xxx` 格式）。

### Step 3: 记录映射

将新群的 chatId 写入映射文件 `workspace/bot-chat-mapping.json`：

```bash
# 读取现有映射
cat workspace/bot-chat-mapping.json

# 追加新条目（使用 jq 或直接编辑）
# key 格式: "discussion-{identifier}"
# 示例:
# {
#   "discussion-pr-feedback": {
#     "chatId": "oc_xxx",
#     "createdAt": "2026-05-17T10:00:00.000Z",
#     "purpose": "discussion"
#   }
# }
```

### Step 4: 发送讨论上下文

使用 MCP 工具将讨论上下文发送到新群。

**简单文本**:

```json
{
  "text": "## 讨论主题: {主题}\n\n### 背景\n{上下文摘要}\n\n### 讨论要点\n- {要点1}\n- {要点2}\n\n请各位发表意见。",
  "chatId": "{new_chat_id}"
}
```

**交互式卡片**（推荐，可包含按钮引导操作）:

```json
{
  "question": "请就以下主题发表意见:\n\n{上下文摘要}",
  "options": [
    { "text": "同意方案 A", "value": "approve-a", "type": "primary" },
    { "text": "同意方案 B", "value": "approve-b" },
    { "text": "需要更多信息", "value": "need-info" }
  ],
  "title": "讨论: {主题}",
  "chatId": "{new_chat_id}"
}
```

### Step 5: 返回确认

向当前对话报告讨论已发起：

```
✅ 已创建讨论群「{群名}」并发送上下文。
Chat ID: {new_chat_id}

当前工作继续进行，不阻塞。
```

## 错误处理

| 场景 | 处理 |
|------|------|
| lark-cli 未安装 | 提示需要安装: `npm install -g @larksuite/cli` |
| 群创建失败 | 报告错误，建议手动创建或检查 lark-cli 配置 |
| 映射文件写入失败 | 记录 chatId（已在群名中编码），不阻塞返回 |
| 消息发送失败 | 报告错误，群已创建可手动发送 |

## 使用场景

### 场景 1: Agent 发现需要深入探讨的话题

```
Agent 在分析代码时发现架构问题，需要与用户深入讨论。
→ 创建讨论群，发送代码片段和问题分析。
→ 继续当前任务。
```

### 场景 2: 离线提问 / 委托讨论

```
用户要求就某个方案征求团队意见。
→ 创建讨论群，发送方案摘要和投票选项。
→ 告知用户讨论已发起。
```

### 场景 3: PR Review 讨论

```
Agent 在扫描 PR 时发现需要多人讨论的设计决策。
→ 创建讨论群，拉入相关审阅者。
→ 发送 PR 链接和需要讨论的具体问题。
```

## Architecture

群组操作使用 **lark-cli** 直接调用飞书 API，不经过 IPC Channel：

```
Agent → Bash → lark-cli im chat create → Feishu API
Agent → MCP send_text/send_interactive → Feishu API (消息发送)
```

## Dependencies

- `lark-cli` — 飞书官方 CLI (`npm install -g @larksuite/cli`)
- `workspace/bot-chat-mapping.json` — BotChatMappingStore 映射文件
- MCP tools: `send_text`, `send_interactive`

## DO NOT

- ❌ 不要通过 MCP 工具创建群组（群组操作走 lark-cli）
- ❌ 不要等待讨论结果后再返回（非阻塞原则）
- ❌ 不要自动解散群组（由 chat-timeout 或用户管理）
- ❌ 不要在 IPC 协议或 MCP Server 中添加群组管理逻辑

## 关联

- Parent: #631 (离线提问)
- Related: rename-group skill (群组重命名)
- Related: pr-scanner skill (PR 讨论群创建)
- Related: BotChatMappingStore (`packages/core/src/scheduling/bot-chat-mapping.ts`)
