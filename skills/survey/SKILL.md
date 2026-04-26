---
name: survey
description: Survey/Polling tool for collecting feedback from specified users. Create and manage surveys with single-choice, multiple-choice, and text questions. Use when user says keywords like "调查", "投票", "问卷", "收集反馈", "survey", "poll", "vote", "feedback collection".
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Survey Manager

Manage lightweight surveys/polls with a three-state lifecycle: **draft → active → closed**.

Each survey is a JSON file in `workspace/surveys/`. Surveys use `send_interactive` cards to collect responses from target users.

## Single Responsibility

- ✅ Create surveys with customizable questions (single-choice, multiple-choice, text)
- ✅ Activate/close surveys
- ✅ Record user responses
- ✅ Aggregate and display results
- ✅ List surveys with status filter
- ❌ DO NOT bypass the lifecycle (draft → active → closed)
- ❌ DO NOT modify responses after recording

## Invocation Modes

### Mode 1: User Invocation

```
/survey create     — Create a new survey
/survey list       — List all surveys
/survey results {id} — Show results for a survey
/survey close {id}   — Close an active survey
```

### Mode 2: Agent Invocation

The agent can create and manage surveys programmatically based on user requests.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Survey File Format

Each survey is a single JSON file in `workspace/surveys/`:

```json
{
  "id": "restaurant-review-001",
  "title": "餐厅评价调查",
  "description": "对昨晚聚餐的餐厅进行评价",
  "status": "draft",
  "createdAt": "2026-04-26T10:00:00Z",
  "activatedAt": null,
  "closedAt": null,
  "expiresAt": "2026-04-28T10:00:00Z",
  "anonymous": false,
  "targetUsers": ["ou_xxx", "ou_yyy"],
  "chatId": "oc_xxx",
  "questions": [
    {
      "id": "q1",
      "type": "single_choice",
      "text": "口味评分",
      "options": ["1⭐", "2⭐", "3⭐", "4⭐", "5⭐"]
    },
    {
      "id": "q2",
      "type": "multiple_choice",
      "text": "你喜欢哪些方面？（可多选）",
      "options": ["口味", "环境", "服务", "性价比", "停车方便"]
    },
    {
      "id": "q3",
      "type": "text",
      "text": "有什么建议？"
    }
  ],
  "responses": {}
}
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique survey identifier (used as filename) |
| `title` | Yes | Survey title (max 128 chars) |
| `description` | No | Description (max 1024 chars) |
| `status` | Yes | `draft`, `active`, or `closed` |
| `expiresAt` | Yes | Auto-expiry timestamp (UTC Z-suffix) |
| `anonymous` | Yes | `true` = responses are anonymous |
| `targetUsers` | Yes | Array of target user open IDs |
| `chatId` | Yes | Originating chat ID |
| `questions` | Yes | Array of question objects |
| `responses` | Yes | Object mapping responder → response |

### Question Types

| Type | Description | Options Required |
|------|-------------|-----------------|
| `single_choice` | Pick one option | Yes (2-10) |
| `multiple_choice` | Pick multiple options | Yes (2-10) |
| `text` | Free-form text answer | No |

## Workflow

### Step 1: Create Survey

```bash
SURVEY_ID="my-survey-001" \
SURVEY_TITLE="餐厅评价调查" \
SURVEY_DESCRIPTION="对昨晚聚餐的餐厅进行评价" \
SURVEY_EXPIRES_AT="2026-04-28T10:00:00Z" \
SURVEY_ANONYMOUS="false" \
SURVEY_TARGET_USERS='["ou_xxx", "ou_yyy"]' \
SURVEY_CHAT_ID="$CHAT_ID" \
SURVEY_QUESTIONS='[{"id":"q1","type":"single_choice","text":"口味评分","options":["1⭐","2⭐","3⭐","4⭐","5⭐"]},{"id":"q2","type":"text","text":"有什么建议？"}]' \
npx tsx skills/survey/create.ts
```

### Step 2: Activate Survey

```bash
SURVEY_ID="my-survey-001" npx tsx skills/survey/activate.ts
```

### Step 3: Send Survey Cards

For each target user, send the survey questions as interactive cards using `send_interactive`.

**Single-choice question**: Use `send_interactive` with one button per option:

```
send_interactive:
  question: "Q1: 口味评分"
  options:
    - {text: "1⭐", value: "q1:1⭐", type: "default"}
    - {text: "2⭐", value: "q1:2⭐", type: "default"}
    - {text: "3⭐", value: "q1:3⭐", type: "default"}
    - {text: "4⭐", value: "q1:4⭐", type: "default"}
    - {text: "5⭐", value: "q1:5⭐", type: "primary"}
  title: "餐厅评价调查 (1/3)"
  chatId: "<target_user_chatId>"
  actionPrompts:
    "q1:1⭐": "[问卷回复] 用户对 q1 选择了 1⭐"
    "q1:2⭐": "[问卷回复] 用户对 q1 选择了 2⭐"
    ...
```

**Text question**: Use `send_interactive` with a confirmation prompt, or ask user to reply directly.

For simplicity, **send all questions in sequence**. When a user clicks a button on a card, the action prompt triggers the agent to record the response.

### Step 4: Record Responses

When a user responds (via action prompt or direct message):

```bash
SURVEY_ID="my-survey-001" \
SURVEY_RESPONDER="ou_xxx" \
SURVEY_ANSWERS='{"q1":"5⭐","q2":"味道很好，服务也不错"}' \
npx tsx skills/survey/respond.ts
```

### Step 5: View Results

```bash
SURVEY_ID="my-survey-001" npx tsx skills/survey/results.ts
```

Display results as a formatted card using `send_card`.

### Step 6: Close Survey (Optional)

```bash
SURVEY_ID="my-survey-001" npx tsx skills/survey/close.ts
```

### List Surveys

```bash
# All surveys
npx tsx skills/survey/list.ts

# Filter by status
SURVEY_STATUS="active" npx tsx skills/survey/list.ts
```

## Sending Survey Results Card

When displaying results, use `send_card` with a well-formatted card:

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"content": "📊 调查结果: {title}", "tag": "plain_text"},
    "template": "blue"
  },
  "elements": [
    {"tag": "markdown", "content": "**参与率**: {responseCount}/{totalCount} ({rate}%)"},
    {"tag": "hr"},
    // Per-question results
    {"tag": "markdown", "content": "**Q1: {questionText}**\n- 5⭐: ████████ 8人\n- 4⭐: ████ 4人\n..."},
    {"tag": "hr"},
    {"tag": "markdown", "content": "**Q2: 文字反馈**\n> 用户A: ...\n> 用户B: ..."}
  ]
}
```

## Important Notes

1. **One survey per interaction**: Focus on collecting feedback for one topic at a time
2. **Respect user time**: Keep surveys short (3-5 questions max recommended)
3. **Clear questions**: Write unambiguous question text
4. **Anonymous mode**: When `anonymous: true`, responder IDs are replaced with "anonymous"
5. **Auto-expiry**: Surveys expire at `expiresAt` but are not auto-closed (must be closed manually or via schedule)
6. **Path safety**: Survey IDs are validated to prevent path traversal attacks
