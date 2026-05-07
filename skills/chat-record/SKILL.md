---
name: chat-record
description: Unified chat record archiver - archives temporary chat sessions with summaries, context, and action items. Supports querying past records. Use when user says "归档群聊", "聊天记录", "群聊总结", "查看历史", "chat record", "chat archive", "chat summary".
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Chat Record — Unified Temporary Chat Archiver

Archive temporary chat sessions with structured summaries, context, and action items. Provides persistent storage and retrieval of past chat records.

**适用于**: 归档群聊、生成总结、检索历史记录 | **不适用于**: 创建群聊、管理群聊生命周期

## When to Use This Skill

**Use this skill for:**
- Archiving a completed temporary chat session with full context
- Generating summaries of past discussions
- Querying archived chat records by topic, date, or keywords
- Providing a "closing record" when a temporary group is dissolved

**Keywords that trigger this skill**: "归档群聊", "聊天记录", "群聊总结", "查看历史记录", "搜索群聊", "chat record", "chat archive", "chat summary", "archive chat"

**Do NOT use this skill for:**
- Creating new temporary chats (use `chat` skill)
- Dissolving groups (use `chat-timeout` skill)
- Managing chat lifecycle (use `chat` skill + `chat-timeout` skill)

## Core Principle

**Use prompt-based analysis, NOT complex program modules.**

The LLM reads chat history, analyzes context, and generates structured summaries directly. State is managed through file-based storage.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Storage Layout

```
workspace/chat-records/
├── index.json                          # Master index of all archived records
├── 2026-05-07_oc_abc123.json           # Structured archive data
├── 2026-05-07_oc_abc123.md             # Human-readable summary
├── 2026-05-06_oc_def456.json
├── 2026-05-06_oc_def456.md
└── ...
```

---

## Workflow

### Operation 1: Archive a Chat Session

Triggers: When a temporary chat is about to be dissolved, or when user explicitly requests archiving.

#### Step 1: Gather Chat Data

Read the chat history and metadata:

```bash
# Read chat history (the agent's conversation log)
cat workspace/chat/{chatId}.md 2>/dev/null | tail -500

# Read chat metadata (if available from ChatStore)
cat workspace/schedules/.temp-chats/{chatId}.json 2>/dev/null

# Or from the newer chat directory
cat workspace/chats/{chatId}.json 2>/dev/null
```

Extract key information:
- **Initiation context**: Why was this chat created? (from metadata `context` field or first messages)
- **Participants**: Who was involved? (from message headers)
- **Duration**: When was it created and how long did it last?
- **Topic**: What was the main subject of discussion?

#### Step 2: Generate Structured Archive

Create a JSON archive file at `workspace/chat-records/{date}_{chatId}.json`:

```json
{
  "archiveId": "{date}_{chatId}",
  "chatId": "{chatId}",
  "archivedAt": "2026-05-07T14:30:00Z",
  "session": {
    "topic": "PR #1234 Code Review Discussion",
    "initiationReason": "PR Scanner detected new PR #1234, created discussion group",
    "participants": ["ou_aaa", "ou_bbb"],
    "participantCount": 2,
    "createdAt": "2026-05-07T10:00:00Z",
    "expiresAt": "2026-05-07T14:30:00Z",
    "durationMinutes": 270,
    "triggerMode": "mention"
  },
  "summary": {
    "keyDiscussionPoints": [
      "Architecture concern about module coupling",
      "Agreement on interface extraction approach",
      "Action item: refactor by Friday"
    ],
    "conclusions": [
      "Team agreed to extract IMessageHandler interface",
      "Implementation deadline set to 2026-05-09"
    ],
    "actionItems": [
      {
        "item": "Refactor MessageHandler to use interface",
        "assignee": "ou_aaa",
        "deadline": "2026-05-09"
      }
    ],
    "outcome": "resolved",
    "outcomeDescription": "Agreement reached on architecture approach. Action items assigned."
  },
  "messageCount": 42,
  "sourceFiles": [
    "workspace/chat/{chatId}.md"
  ]
}
```

**Outcome types**:
| Type | Description |
|------|-------------|
| `resolved` | Issue was resolved with clear conclusions |
| `partial` | Partial progress, follow-up needed |
| `timeout` | Chat expired without resolution |
| `informational` | No resolution needed (survey, info sharing) |

#### Step 3: Generate Human-Readable Summary

Create a Markdown summary at `workspace/chat-records/{date}_{chatId}.md`:

```markdown
# Chat Summary: PR #1234 Code Review Discussion

> Archived: 2026-05-07 14:30 UTC | Duration: 4h 30m | Participants: 2

## Context

This discussion was initiated by PR Scanner for PR #1234. The group was created to review the proposed changes to the messaging architecture.

## Key Discussion Points

1. **Architecture concern** — Module coupling between MessageHandler and TransportLayer
2. **Interface extraction** — Agreement to extract `IMessageHandler` interface
3. **Timeline** — Refactor targeted for completion by Friday

## Conclusions

- Team agreed on interface extraction approach
- Implementation deadline: 2026-05-09

## Action Items

- [ ] Refactor MessageHandler to use interface — @ou_aaa — Due: 2026-05-09

## Outcome

✅ Resolved — Agreement reached on architecture approach.
```

#### Step 4: Update Master Index

Read and update the master index file:

```bash
cat workspace/chat-records/index.json 2>/dev/null || echo '{"records":[],"updatedAt":null}'
```

Append the new record entry to the `records` array:

```json
{
  "records": [
    {
      "archiveId": "2026-05-07_oc_abc123",
      "chatId": "oc_abc123",
      "topic": "PR #1234 Code Review Discussion",
      "archivedAt": "2026-05-07T14:30:00Z",
      "outcome": "resolved",
      "participantCount": 2,
      "messageCount": 42
    }
  ],
  "updatedAt": "2026-05-07T14:30:00Z"
}
```

Write the updated index back to `workspace/chat-records/index.json`.

#### Step 5: Notify (if applicable)

If the archive was triggered by the chat-timeout flow (group dissolution), send a brief notification to the creator's chat (if `creatorChatId` is available):

```markdown
📋 **群聊已归档**

**主题**: {topic}
**时长**: {duration}
**参与者**: {count} 人
**结论**: {outcome_description}

归档文件已保存，可随时查看历史记录。
```

---

### Operation 2: Query Past Records

Triggers: When user asks about past discussions, searches for specific topics, or wants to review chat history.

#### Step 2a: Search by Keyword

```bash
# Search in archive summaries
grep -rl "{keyword}" workspace/chat-records/*.md

# Or search in JSON data
grep -rl "{keyword}" workspace/chat-records/*.json
```

#### Step 2b: Search by Date

```bash
# List records for a specific date
ls workspace/chat-records/2026-05-07_*.json

# List records for a date range
ls workspace/chat-records/2026-05-0{1,2,3,4,5}_*.json
```

#### Step 2c: List Recent Records

```bash
# Read the master index for recent records
cat workspace/chat-records/index.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
records = sorted(data.get('records', []), key=lambda r: r['archivedAt'], reverse=True)
for r in records[:10]:
    print(f\"{r['archivedAt'][:10]} | {r['topic'][:40]} | {r['outcome']} | {r['participantCount']}p\")
"
```

#### Step 2d: Display Results

When displaying search results, show a formatted list:

```markdown
📋 **找到 {count} 条记录**

| 日期 | 主题 | 结果 | 参与者 |
|------|------|------|--------|
| 2026-05-07 | PR #1234 Review | ✅ 已解决 | 2人 |
| 2026-05-06 | Bug #5678 排查 | ⏳ 部分 | 3人 |

使用「查看归档 {archiveId}」查看详细记录。
```

For a specific record, display the full Markdown summary.

---

### Operation 3: Review Statistics

Triggers: When user asks for overall statistics about past chats.

Read the master index and aggregate:

```markdown
📊 **群聊统计** (截至 {date})

- **总归档数**: {total}
- **本周**: {this_week_count}
- **结果分布**:
  - ✅ 已解决: {resolved_count} ({resolved_pct}%)
  - ⏳ 部分完成: {partial_count} ({partial_pct}%)
  - ⏰ 超时: {timeout_count} ({timeout_pct}%)
  - ℹ️ 信息分享: {info_count} ({info_pct}%)
- **平均参与者**: {avg_participants} 人
- **平均消息数**: {avg_messages} 条
```

---

## Integration Points

| Component | Integration |
|-----------|------------|
| `chat-timeout` skill | Before dissolving a group, invoke this skill to archive the session |
| `chat` skill | When creating a chat, record the initiation context for later archiving |
| `pr-scanner` skill | PR discussion groups can be archived when PRs are closed/merged |
| `daily-chat-review` skill | Can use archived records for pattern analysis |

### Integration with chat-timeout

When the chat-timeout skill detects an expired chat and before dissolution:

1. **Chat-timeout invokes chat-record** to archive the session
2. **Chat-record generates summary** and saves archive files
3. **Chat-timeout proceeds** with dissolution after archiving

This ensures no chat session is lost without a record.

---

## Error Handling

| Error | Recovery |
|-------|----------|
| Chat history file not found | Create minimal archive with available metadata |
| Index file corrupted | Rebuild index from individual archive files |
| Disk write failure | Log error, retry once, continue with dissolution |
| Malformed archive JSON | Skip corrupted records during queries |

---

## Configuration

No configuration required. All paths are relative to the workspace root.

### Environment Variables (Optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAT_RECORD_MAX_HISTORY` | `90` | Days to retain archived records |
| `CHAT_RECORD_MAX_SUMMARY_LENGTH` | `2000` | Max characters for summary section |

---

## Examples

### Example 1: Archive a PR Review Discussion

**Scenario**: PR #1234 discussion group is about to be dissolved after 4 hours.

**Agent reads**:
- `workspace/chat/oc_abc123.md` → 42 messages discussing architecture
- `workspace/chats/oc_abc123.json` → Created by PR Scanner, context: "PR #1234 review"

**Agent generates**:
- `workspace/chat-records/2026-05-07_oc_abc123.json` → Structured data
- `workspace/chat-records/2026-05-07_oc_abc123.md` → Human-readable summary

### Example 2: Search Past Discussions

**User**: "查看之前关于架构的讨论"

**Agent searches**: `grep -rl "架构" workspace/chat-records/*.md`

**Agent displays**: Matching records with date, topic, and outcome.

### Example 3: Weekly Review

**User**: "这周有哪些群聊讨论？"

**Agent lists**: All records from this week from the master index, formatted as a table.

---

## DO NOT

- ❌ Archive chats that are still active (only archive completed/expired chats)
- ❌ Delete original chat history files when archiving (keep originals)
- ❌ Include sensitive information (tokens, passwords) in archives
- ❌ Auto-archive without explicit trigger (from chat-timeout or user request)
- ❌ Modify the archive after creation (archives are immutable records)
- ❌ Send archive content to chats other than the creator's chat
