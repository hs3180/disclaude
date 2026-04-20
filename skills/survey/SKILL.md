---
name: survey
description: Survey/Poll creator - create and manage surveys to collect feedback from specified users via interactive cards. Use when user says keywords like "调查", "投票", "问卷", "survey", "poll", "收集反馈", "feedback collection".
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Survey Manager

Create and manage lightweight surveys/polls to collect feedback from specified users via interactive cards.

## Overview

This skill implements a built-in lightweight survey system (方案 C) using interactive cards and JSON file storage. It supports:

- **Single choice** questions (select one from options)
- **Text** questions (open-ended responses)
- **Anonymous** mode (hide responder identities in results)
- **Expiry deadlines** (auto-expire surveys)
- **Targeted delivery** (send to specific users)

## Single Responsibility

- ✅ Create survey data files
- ✅ Send survey cards to target users
- ✅ Record user responses
- ✅ Aggregate and display results
- ✅ Close surveys
- ❌ DO NOT send survey cards to non-target users
- ❌ DO NOT modify responses after recording

## Invocation Modes

### Mode 1: Direct User Invocation

```
/survey create     — Create a new survey
/survey list       — List all surveys (optional --status filter)
/survey query {id} — Query survey details
/survey results {id} — View aggregated results
/survey close {id} — Close an open survey
```

### Mode 2: Agent Invocation

Called by other agents/skills that need to collect feedback from users.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Survey File Format

Each survey is a JSON file in `workspace/surveys/`:

```json
{
  "id": "survey-001",
  "title": "餐厅评价",
  "description": "请对最近的团建餐厅进行评价",
  "status": "open",
  "anonymous": false,
  "createdAt": "2026-04-20T10:00:00Z",
  "expiresAt": "2026-04-27T10:00:00Z",
  "closedAt": null,
  "creator": "ou_xxx",
  "targetUsers": ["ou_aaa", "ou_bbb"],
  "questions": [
    {
      "id": "q1",
      "type": "single_choice",
      "question": "整体评分",
      "options": ["⭐ 1分", "⭐⭐ 2分", "⭐⭐⭐ 3分", "⭐⭐⭐⭐ 4分", "⭐⭐⭐⭐⭐ 5分"],
      "required": true
    },
    {
      "id": "q2",
      "type": "text",
      "question": "有什么建议吗？",
      "required": false
    }
  ],
  "responses": {}
}
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique survey identifier (filename: `{id}.json`) |
| `title` | Yes | Survey title (max 128 chars) |
| `description` | No | Description text (max 1024 chars) |
| `status` | Yes | `open` → `closed` |
| `anonymous` | No | Hide responder identities in results (default: false) |
| `createdAt` | Yes | ISO 8601 Z-suffix timestamp |
| `expiresAt` | Yes | ISO 8601 Z-suffix expiry timestamp |
| `closedAt` | No | ISO 8601 timestamp (set when closed) |
| `creator` | Yes | Creator's open ID |
| `targetUsers` | Yes | Array of target user open IDs |
| `questions` | Yes | Array of question objects |
| `responses` | Yes | Object keyed by responder open ID |

### Question Types

| Type | Fields | Description |
|------|--------|-------------|
| `single_choice` | `options` (required) | Select one from predefined options |
| `text` | — | Open-ended text response |

## Operations

All scripts accept input via **environment variables** and are in `skills/survey/`.

### 1. Create Survey

```bash
SURVEY_ID="survey-001" \
SURVEY_TITLE="餐厅评价" \
SURVEY_DESCRIPTION="请评价最近的团建餐厅" \
SURVEY_EXPIRES_AT="2026-04-27T10:00:00Z" \
SURVEY_CREATOR="ou_xxx" \
SURVEY_TARGET_USERS='["ou_aaa", "ou_bbb"]' \
SURVEY_QUESTIONS='[
  {"id":"q1","type":"single_choice","question":"整体评分","options":["⭐ 1分","⭐⭐⭐⭐⭐ 5分"],"required":true},
  {"id":"q2","type":"text","question":"有什么建议？","required":false}
]' \
SURVEY_ANONYMOUS="false" \
npx tsx skills/survey/create.ts
```

### 2. Send Survey Cards

After creating the survey, send an interactive card to each target user for each **single_choice** question:

```
Use send_interactive MCP tool:

For each target user and each single_choice question:
{
  "chatId": "{user_chatId}",
  "question": "{question_text}",
  "title": "📋 {survey_title} — 问题 {question_id}",
  "context": "截止时间: {expires_at}",
  "options": [
    { "text": "{option_1}", "value": "survey-{survey_id}-q1-{option_1}", "type": "default" },
    { "text": "{option_2}", "value": "survey-{survey_id}-q1-{option_2}", "type": "default" }
  ],
  "actionPrompts": {
    "survey-{survey_id}-q1-{option_1}": "[投票] 用户对调查 {survey_id} 的问题 q1 选择了 '{option_1}'。请使用 respond.ts 记录响应: SURVEY_ID={survey_id} SURVEY_RESPONDER=ou_from_context SURVEY_RESPONSES='{\"q1\": \"{option_1}\"}' npx tsx skills/survey/respond.ts",
    "survey-{survey_id}-q1-{option_2}": "[投票] 用户对调查 {survey_id} 的问题 q1 选择了 '{option_2}'。请使用 respond.ts 记录响应: SURVEY_ID={survey_id} SURVEY_RESPONDER=ou_from_context SURVEY_RESPONSES='{\"q1\": \"{option_2}\"}' npx tsx skills/survey/respond.ts"
  }
}
```

> **Note**: For `text` type questions, send a text message asking users to reply with their answer. The agent then records the response manually.

### 3. Record Response

```bash
SURVEY_ID="survey-001" \
SURVEY_RESPONDER="ou_aaa" \
SURVEY_RESPONSES='{"q1": "⭐⭐⭐⭐⭐ 5分", "q2": "菜品很好，服务也棒"}' \
npx tsx skills/survey/respond.ts
```

**Idempotency**: If a user has already responded, the script rejects the write.

### 4. Query Survey

```bash
SURVEY_ID="survey-001" npx tsx skills/survey/query.ts
```

### 5. View Results

```bash
SURVEY_ID="survey-001" npx tsx skills/survey/results.ts
```

Output includes:
- Completion rate
- Per-question aggregation (bar charts for single_choice, list for text)
- Pending responders (non-anonymous only)

### 6. Close Survey

```bash
SURVEY_ID="survey-001" npx tsx skills/survey/close.ts
```

### 7. List Surveys

```bash
# List all surveys
npx tsx skills/survey/list.ts

# Filter by status
SURVEY_STATUS="open" npx tsx skills/survey/list.ts
```

## Lifecycle

```
┌─────────┐    close.ts    ┌─────────┐
│  open   │ ──────────────>│ closed  │
│ 接受响应 │               │ 已关闭  │
└─────────┘               └─────────┘
     │
     │ expiresAt reached
     ▼
  (auto-expired by respond.ts validation)
```

## Survey Directory

```
workspace/surveys/
├── survey-001.json    # Restaurant review survey
├── poll-2026-04.json  # Weekly poll
└── team-vote.json     # Team decision vote
```

## Workflow Example

### Creator Creates and Sends Survey

1. Creator says: "帮我做一个调查，问大家对项目的满意度"

2. Agent creates the survey:
   ```bash
   SURVEY_ID="satisfaction-2026q2" \
   SURVEY_TITLE="项目满意度调查" \
   SURVEY_EXPIRES_AT="2026-04-27T10:00:00Z" \
   SURVEY_CREATOR="ou_creator" \
   SURVEY_TARGET_USERS='["ou_user1", "ou_user2"]' \
   SURVEY_QUESTIONS='[{"id":"q1","type":"single_choice","question":"你对当前项目进展满意吗？","options":["😊 非常满意","🙂 比较满意","😐 一般","😟 不太满意"],"required":true},{"id":"q2","type":"text","question":"有什么改进建议？","required":false}]' \
   npx tsx skills/survey/create.ts
   ```

3. Agent sends interactive cards to each target user for each single_choice question.

### User Responds

4. User clicks a button on the card → agent receives actionPrompt → records response:
   ```bash
   SURVEY_ID="satisfaction-2026q2" \
   SURVEY_RESPONDER="ou_user1" \
   SURVEY_RESPONSES='{"q1": "😊 非常满意"}' \
   npx tsx skills/survey/respond.ts
   ```

### Creator Views Results

5. Creator asks for results → agent runs:
   ```bash
   SURVEY_ID="satisfaction-2026q2" npx tsx skills/survey/results.ts
   ```

## DO NOT

- ❌ Send survey cards to users who are not in `targetUsers`
- ❌ Allow multiple responses from the same user
- ❌ Record responses for closed or expired surveys
- ❌ Modify or delete existing responses
- ❌ Use YAML format (always JSON)
- ❌ Delete survey files manually
