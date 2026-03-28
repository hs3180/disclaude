---
name: temporary-session
description: Guide agents on creating and managing temporary group chats with automatic lifecycle. Use when you need to create a discussion group, send an interactive card, and have it auto-cleaned after timeout. Keywords: temporary session, temp chat, create group, discussion, temp group, 临时会话, 临时群聊.
allowed-tools: [create_chat, register_temp_chat, dissolve_chat, send_interactive, send_text, send_card, send_file]
---

# Temporary Session Skill

Guide agents through the temporary group chat workflow using existing MCP tools.

The core infrastructure (ChatStore + TempChatLifecycleService from Issue #1703) handles persistence and automatic expiry. This skill provides workflow guidance only — no custom persistence layer.

## When to Use This Skill

**Trigger conditions:**
- You need to create a temporary discussion group
- You need to collect user feedback via interactive cards in a group
- You need a time-limited chat that auto-dissolves after expiry
- User mentions: "临时群聊", "temporary session", "temp chat", "讨论群", "限时讨论"

## Single Responsibility

- ✅ Guide agents on using MCP tools for temp chat workflow
- ✅ Provide card templates and action prompt patterns
- ✅ Document best practices for temp chat lifecycle
- ❌ DO NOT create custom persistence (use `register_temp_chat`)
- ❌ DO NOT manually manage expiry (TempChatLifecycleService handles it)
- ❌ DO NOT create YAML/JSON session files

## Architecture (DO NOT Violate)

```
MCP Tool (thin wrapper) → IPC → Core (ChatStore) → Primary Node (TempChatLifecycleService)
```

| Layer | Component | Responsibility |
|-------|-----------|----------------|
| MCP Tool | `register_temp_chat` | Register chat for lifecycle tracking |
| Core | ChatStore | File-based persistence |
| Primary Node | TempChatLifecycleService | Periodic expiry check + auto-dissolve (every 5 min) |

**Anti-pattern (rejected in 5 PRs):** Creating a parallel YAML/JSON session management system. Always use the existing infrastructure.

## Workflow

### Pattern A: Direct Creation (Agent-Initiated)

Use when the agent can immediately create the group and send the card.

```
Step 1: create_chat → get chatId
Step 2: register_temp_chat(chatId, { expiresAt, context }) → track lifecycle
Step 3: send_interactive(chatId, question, options, actionPrompts) → engage user
```

#### Step 1: Create Group Chat

```json
{
  "name": "PR #123 Review",
  "description": "Discussion for PR #123",
  "memberIds": ["ou_user1", "ou_user2"]
}
```

The `create_chat` tool returns a `chatId`. Save this for subsequent steps.

#### Step 2: Register for Lifecycle Tracking

```json
{
  "chatId": "<chatId from Step 1>",
  "expiresAt": "2026-03-29T10:00:00.000Z",
  "creatorChatId": "<originating chat ID, optional>",
  "context": {
    "source": "pr-scanner",
    "prNumber": 123
  }
}
```

**Parameters:**
- `chatId` (required): The chat ID from Step 1
- `expiresAt` (optional): ISO timestamp, defaults to 24 hours
- `creatorChatId` (optional): For notification when chat expires
- `context` (optional): Arbitrary data for consumer identification

#### Step 3: Send Interactive Card

```json
{
  "question": "## PR #123 Review\n\nPlease review and decide:",
  "options": [
    { "text": "✅ Merge", "value": "merge", "type": "primary" },
    { "text": "🔄 Request Changes", "value": "request_changes" },
    { "text": "❌ Close", "value": "close", "type": "danger" },
    { "text": "⏳ Later", "value": "later" }
  ],
  "title": "PR Review Decision",
  "chatId": "<chatId from Step 1>",
  "actionPrompts": {
    "merge": "[用户操作] 用户选择合并 PR #123。请执行 gh pr merge 并报告结果。",
    "request_changes": "[用户操作] 用户请求修改 PR #123。请询问具体修改内容。",
    "close": "[用户操作] 用户关闭 PR #123。请执行 gh pr close 并报告结果。",
    "later": "[用户操作] 用户选择稍后处理 PR #123。记录状态，下次再处理。"
  }
}
```

### Pattern B: With Notification (Notify Creator on Expiry)

Use when the originating chat should be notified when the temp chat expires.

```
Step 1: create_chat → get chatId
Step 2: register_temp_chat(chatId, { creatorChatId, context }) → track + notify
Step 3: send_interactive(chatId, ...) → engage user
```

When the temp chat expires, the TempChatLifecycleService will dissolve it. Include `creatorChatId` so future implementations can notify the originating chat.

### Pattern C: Extended Interaction (Multiple Cards)

Use when the workflow requires multiple rounds of interaction.

```
Step 1: create_chat → get chatId
Step 2: register_temp_chat(chatId, { expiresAt: "48h" }) → extended lifecycle
Step 3: send_interactive(chatId, initial_options) → first round
Step 4: [User responds] → process response
Step 5: send_interactive(chatId, follow_up_options) → second round
...
Step N: [Timeout or completion] → TempChatLifecycleService auto-dissolves
```

**Tip:** Set a longer `expiresAt` (e.g., 48h) for multi-round interactions.

## Automatic Lifecycle (No Action Required)

The TempChatLifecycleService (Primary Node) automatically:
- Checks for expired temp chats every 5 minutes
- Dissolves expired groups via `dissolveChat`
- Cleans up registration records

**You do NOT need to:**
- Manually check expiry
- Manually dissolve groups
- Clean up records

## Best Practices

| Practice | Recommendation |
|----------|---------------|
| Expiry time | 1-4 hours for quick decisions, 24h default for general use |
| Context data | Always include `source` field for consumer identification |
| Action prompts | Include `[用户操作]` prefix for clear routing |
| Group naming | Use descriptive names like `"PR #123 Review"` |
| Member IDs | Only add members who need to participate |

## Anti-Patterns (Learned from 5 Rejected PRs)

| ❌ Don't | ✅ Do Instead |
|-----------|---------------|
| Create YAML/JSON session files | Use `register_temp_chat` MCP tool |
| Build custom expiry checker | Rely on TempChatLifecycleService |
| Manage lifecycle in Schedule | The infrastructure handles it automatically |
| Create parallel persistence layer | Use ChatStore via IPC |
| Store state in workspace files | Use `context` parameter of `register_temp_chat` |

## Example: PR Review Discussion

**Scenario:** Agent needs to create a temporary group for reviewing a PR.

```
1. Agent calls create_chat:
   name: "PR #456 Discussion"
   → Returns chatId: "oc_abc123"

2. Agent calls register_temp_chat:
   chatId: "oc_abc123"
   expiresAt: "2026-03-28T18:00:00.000Z"  (4 hours from now)
   context: { source: "pr-scanner", prNumber: 456 }
   → Registered successfully

3. Agent calls send_interactive:
   chatId: "oc_abc123"
   question: "## PR #456: Fix login timeout\n\n..."
   options: [approve, request_changes, close]
   → Card sent to group

4. User clicks "approve"
   → Agent receives action prompt with "[用户操作]..."
   → Agent processes approval

5. [4 hours later]
   → TempChatLifecycleService auto-dissolves "oc_abc123"
   → No manual action needed
```

## DO NOT

- ❌ Create session files in workspace (use `register_temp_chat`)
- ❌ Implement custom expiry logic (TempChatLifecycleService handles it)
- ❌ Manually call `dissolve_chat` for lifecycle cleanup (only for immediate needs)
- ❌ Build parallel management systems (follow the 4-layer architecture)
- ❌ Use this skill for permanent groups (only for temporary/time-limited chats)
