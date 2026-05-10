---
name: chat-record
description: Unified group chat record management — archive temporary group chats with context, generate summaries, and retrieve past chat records. Use when a temporary group chat is closing, when user asks about past discussions, or says keywords like "群聊记录", "聊天总结", "归档", "chat record", "chat summary", "archive chat".
allowed-tools: Read, Write, Glob, Bash, send_user_feedback
---

# Chat Record — Unified Group Chat Records

Manage unified records for temporary group chats: archive with context, generate summaries, and enable retrieval.

## When to Use This Skill

**Use this skill for:**
- Archiving a temporary group chat when it is about to close
- Generating a summary of a group chat discussion
- Retrieving or searching past group chat records
- Listing recent archived chats

**Keywords that trigger this skill**: "群聊记录", "聊天总结", "归档", "chat record", "chat summary", "archive chat", "历史群聊"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Archive Storage

All archived chats are stored in:

```
workspace/chat-archives/
├── index.json                  # Index for fast lookups
├── oc_chat001.json             # Individual archive record
├── oc_chat002.json
└── ...
```

### Archive Record Structure

Each `{chatId}.json` contains:

```json
{
  "chatId": "oc_xxx",
  "createdAt": "2026-05-10T08:00:00.000Z",
  "closedAt": "2026-05-10T10:30:00.000Z",
  "topic": "PR #1234 Code Review Discussion",
  "purpose": "pr-review",
  "creatorChatId": "oc_main",
  "participants": ["ou_user1", "ou_user2"],
  "status": "completed",
  "summary": {
    "topic": "Review of authentication module refactor",
    "conclusions": [
      "Agreed on using JWT for session management",
      "Database migration plan approved"
    ],
    "actionItems": [
      "Update session middleware to use JWT",
      "Add migration script for existing sessions"
    ],
    "generatedAt": "2026-05-10T10:30:00.000Z"
  },
  "messageCount": 42
}
```

---

## Core Operations

### Operation 1: Archive a Closing Chat

When a temporary group chat is about to be closed (via chat-timeout or manual closure):

**Step 1: Read the chat logs**

```
Read chat log files from:
workspace/chat/{YYYY-MM-DD}/{chatId}.md
```

Use `Glob` to find all relevant log files for this chatId across dates:
```
Glob pattern: workspace/chat/**/{chatId}.md
```

**Step 2: Generate a summary**

Based on the chat logs, generate a structured summary:

```json
{
  "topic": "Brief description of what was discussed",
  "conclusions": ["Key conclusion 1", "Key conclusion 2"],
  "actionItems": ["Action item 1", "Action item 2"],
  "generatedAt": "<current ISO timestamp>"
}
```

Summary guidelines:
- `topic`: One sentence summarizing the discussion topic
- `conclusions`: Key decisions, agreements, or findings (2-5 items)
- `actionItems`: Concrete next steps with owners if mentioned (2-5 items)
- If the chat expired without activity, set summary to `null`

**Step 3: Create the archive record**

Write the archive record to `workspace/chat-archives/{chatId}.json`:

```json
{
  "chatId": "<chatId>",
  "createdAt": "<from original temp chat record>",
  "closedAt": "<current ISO timestamp>",
  "topic": "<descriptive topic from context or summary>",
  "purpose": "<pr-review, discussion, feedback, etc.>",
  "creatorChatId": "<originating chat if known>",
  "participants": [],
  "status": "completed",
  "summary": { ... },
  "messageCount": <count from logs>
}
```

**Step 4: Update the index**

Read `workspace/chat-archives/index.json`, append the new entry, and write back:

```json
[
  {
    "chatId": "oc_xxx",
    "topic": "PR #1234 Code Review Discussion",
    "purpose": "pr-review",
    "createdAt": "2026-05-10T08:00:00.000Z",
    "closedAt": "2026-05-10T10:30:00.000Z",
    "status": "completed"
  }
]
```

If index.json doesn't exist, create it.

**Step 5: Notify the creator chat**

If `creatorChatId` is known, send a brief summary card:

```
Use send_card to send a summary card to the creator chat:
- Header: "📋 群聊归档总结"
- Body: Topic, conclusions, action items
```

### Operation 2: Retrieve Past Chat Records

When user asks about past discussions:

**List recent archives:**

1. Read `workspace/chat-archives/index.json`
2. Sort by `closedAt` descending
3. Present the list to the user

**Search by keyword:**

1. Read `workspace/chat-archives/index.json`
2. Filter entries where `topic` or `purpose` matches the keyword
3. For deeper search, read individual archive files and check `summary.conclusions` and `summary.actionItems`

**Get full record:**

1. Read `workspace/chat-archives/{chatId}.json`
2. Present the full record including summary

### Operation 3: Summarize an Active Chat

When user asks for a summary of the current active group chat:

1. Read chat logs using `Glob`: `workspace/chat/**/{chatId}.md`
2. Analyze the content
3. Generate and present a summary (conclusions + action items)
4. Optionally save it back to the archive if the chat is already archived

---

## Summary Generation Guidelines

### What Makes a Good Summary

1. **Concise topic**: One sentence that captures the main subject
2. **Conclusions**: Key decisions or findings, not a transcript
3. **Action items**: Concrete, actionable next steps

### What to Include

- Decisions made or agreed upon
- Technical conclusions (e.g., "use library X for Y")
- Assigned tasks or responsibilities
- Open questions that remain unresolved

### What to Exclude

- Greetings and social messages
- Procedural messages (e.g., "joined the group")
- Redundant or repetitive content
- Sensitive information (tokens, keys, passwords)

---

## DO NOT

- Delete archive records without explicit user request
- Include sensitive information in summaries
- Create archives for non-temporary chats
- Overwrite existing archives without confirmation
- Generate summaries for empty/inactive chats (mark as `expired` instead)
