---
name: survey
description: Survey/Polling feature - create interactive surveys to collect feedback from specified users via Feishu cards. Use when user says keywords like "调查", "投票", "问卷", "收集反馈", "survey", "poll", "vote", "feedback collection".
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Survey Manager

Create and manage interactive surveys to collect feedback from Feishu group members.

## Single Responsibility

- ✅ Create survey files with questions and options
- ✅ Record user responses
- ✅ Aggregate and display results
- ✅ Send survey cards via `send_interactive` MCP tool
- ❌ DO NOT create groups (use existing group chats)
- ❌ DO NOT handle card callback routing (handled by Primary Node)

## When to Use This Skill

**Use this skill when:**
- User wants to collect feedback/opinions from group members
- User wants to create a poll or vote
- User wants to survey team preferences
- Keywords: "调查", "投票", "问卷", "收集反馈", "survey", "poll", "vote"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Survey File Format

Each survey is a JSON file in `workspace/surveys/`:

```json
{
  "id": "restaurant-review",
  "title": "餐厅评价调查",
  "description": "请对最近团建的餐厅进行评价",
  "chatId": "oc_xxx",
  "createdAt": "2026-04-18T10:00:00Z",
  "expiresAt": "2026-04-19T10:00:00Z",
  "anonymous": false,
  "status": "active",
  "questions": [
    {
      "id": "q1",
      "type": "single_choice",
      "question": "您对菜品口味如何评价？",
      "options": [
        {"text": "⭐⭐⭐⭐⭐ 非常满意", "value": "5"},
        {"text": "⭐⭐⭐⭐ 满意", "value": "4"},
        {"text": "⭐⭐⭐ 一般", "value": "3"},
        {"text": "⭐⭐ 不满意", "value": "2"},
        {"text": "⭐ 非常不满意", "value": "1"}
      ]
    }
  ],
  "responses": {}
}
```

---

## Operations

All scripts are located in `skills/survey/` and run via `npx tsx`.

### 1. Create Survey

```bash
SURVEY_ID="restaurant-review" \
SURVEY_TITLE="餐厅评价调查" \
SURVEY_CHAT_ID="oc_xxx" \
SURVEY_EXPIRES_AT="2026-04-19T10:00:00Z" \
SURVEY_QUESTIONS='[
  {
    "id": "q1",
    "type": "single_choice",
    "question": "您对菜品口味如何评价？",
    "options": [
      {"text": "⭐⭐⭐⭐⭐ 非常满意", "value": "5"},
      {"text": "⭐⭐⭐⭐ 满意", "value": "4"},
      {"text": "⭐⭐⭐ 一般", "value": "3"},
      {"text": "⭐⭐ 不满意", "value": "2"}
    ]
  }
]' \
SURVEY_DESCRIPTION="请对最近团建的餐厅进行评价" \
npx tsx skills/survey/create.ts
```

**Validation** (built into script):
- `SURVEY_ID` must match `^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$`
- `SURVEY_CHAT_ID` must match `oc_xxx` format
- `SURVEY_EXPIRES_AT` must be UTC Z-suffix ISO 8601
- `SURVEY_QUESTIONS` must be valid JSON array with at least 1 question
- Each question must have at least 2 options

### 2. Send Survey Cards

After creating the survey, send an interactive card for each question:

```
send_interactive({
  question: "您对菜品口味如何评价？",
  options: [
    { text: "⭐⭐⭐⭐⭐ 非常满意", value: "5", type: "primary" },
    { text: "⭐⭐⭐⭐ 满意", value: "4" },
    { text: "⭐⭐⭐ 一般", value: "3" },
    { text: "⭐⭐ 不满意", value: "2", type: "danger" }
  ],
  title: "📊 餐厅评价调查",
  chatId: "oc_xxx",
  actionPrompts: {
    "5": "[调查投票] 用户在调查 restaurant-review 问题 q1 选择了 ⭐⭐⭐⭐⭐ 非常满意。请执行：SURVEY_ID=\"restaurant-review\" SURVEY_RESPONDER=\"\" SURVEY_QUESTION_ID=\"q1\" SURVEY_ANSWER=\"5\" npx tsx skills/survey/response.ts",
    "4": "[调查投票] 用户在调查 restaurant-review 问题 q1 选择了 ⭐⭐⭐⭐ 满意。请执行：SURVEY_ID=\"restaurant-review\" SURVEY_RESPONDER=\"\" SURVEY_QUESTION_ID=\"q1\" SURVEY_ANSWER=\"4\" npx tsx skills/survey/response.ts",
    "3": "[调查投票] 用户在调查 restaurant-review 问题 q1 选择了 ⭐⭐⭐ 一般。请执行：SURVEY_ID=\"restaurant-review\" SURVEY_RESPONDER=\"\" SURVEY_QUESTION_ID=\"q1\" SURVEY_ANSWER=\"3\" npx tsx skills/survey/response.ts",
    "2": "[调查投票] 用户在调查 restaurant-review 问题 q1 选择了 ⭐⭐ 不满意。请执行：SURVEY_ID=\"restaurant-review\" SURVEY_RESPONDER=\"\" SURVEY_QUESTION_ID=\"q1\" SURVEY_ANSWER=\"2\" npx tsx skills/survey/response.ts"
  }
})
```

**IMPORTANT**: In `actionPrompts`, you MUST leave `SURVEY_RESPONDER` empty (`\"\"`). The system will automatically fill in the responder's open ID when the user clicks a button. When processing the vote, detect the sender from the incoming message context (Sender Open ID).

### 3. Record Response

When a user clicks a button, the action prompt triggers. Use the Sender Open ID from the message context:

```bash
SURVEY_ID="restaurant-review" \
SURVEY_RESPONDER="ou_xxx" \
SURVEY_QUESTION_ID="q1" \
SURVEY_ANSWER="5" \
npx tsx skills/survey/response.ts
```

**Features**:
- Users can change their vote (response is updated)
- Validates that the answer is a valid option
- Rejects responses to expired or closed surveys

### 4. View Results

```bash
SURVEY_ID="restaurant-review" npx tsx skills/survey/results.ts
```

Output includes:
- Per-question vote tallies with visual bar charts
- Percentages for each option
- Completion rates per question
- Total respondent count

---

## Complete Workflow

```
1. User requests survey → Agent creates survey file via create.ts
2. Agent sends interactive card(s) via send_interactive MCP tool
3. User clicks button → action prompt triggers agent
4. Agent records response via response.ts
5. User asks for results → Agent calls results.ts
6. Agent sends formatted results card via send_card
```

---

## Example: Restaurant Review Survey

### Agent Creates Survey

```bash
SURVEY_ID="restaurant-review-0418" \
SURVEY_TITLE="团建餐厅评价" \
SURVEY_CHAT_ID="oc_xxx" \
SURVEY_EXPIRES_AT="2026-04-20T10:00:00Z" \
SURVEY_QUESTIONS='[
  {"id": "q1", "type": "single_choice", "question": "菜品口味如何？", "options": [
    {"text": "非常满意 ⭐⭐⭐⭐⭐", "value": "5"},
    {"text": "满意 ⭐⭐⭐⭐", "value": "4"},
    {"text": "一般 ⭐⭐⭐", "value": "3"},
    {"text": "不满意 ⭐⭐", "value": "2"},
    {"text": "非常不满意 ⭐", "value": "1"}
  ]},
  {"id": "q2", "type": "single_choice", "question": "环境如何？", "options": [
    {"text": "很好", "value": "good"},
    {"text": "一般", "value": "ok"},
    {"text": "较差", "value": "bad"}
  ]}
]' \
SURVEY_DESCRIPTION="请对 4/18 团建餐厅进行评价" \
npx tsx skills/survey/create.ts
```

### Agent Sends Cards

Send one `send_interactive` per question with appropriate `actionPrompts`.

### User Clicks Button

Agent receives action prompt, extracts Sender Open ID, and records:

```bash
SURVEY_ID="restaurant-review-0418" SURVEY_RESPONDER="ou_xxx" SURVEY_QUESTION_ID="q1" SURVEY_ANSWER="4" npx tsx skills/survey/response.ts
```

### Agent Shows Results

```bash
SURVEY_ID="restaurant-review-0418" npx tsx skills/survey/results.ts
```

---

## Survey Directory

```
workspace/surveys/
├── restaurant-review-0418.json    # Active survey
├── team-satisfaction-q1.json      # Another survey
└── ...
```

## DO NOT

- ❌ Send survey cards without first creating the survey file
- ❌ Record responses with invalid survey/question IDs
- ❌ Modify survey files manually (always use the scripts)
- ❌ Create surveys without a valid `expiresAt` (must be UTC Z-suffix)
- ❌ Use more than 20 questions per survey
- ❌ Use more than 10 options per question

## Error Handling

| Scenario | Action |
|----------|--------|
| Survey file not found | Report "Survey {id} not found" |
| Survey expired | Report "Survey {id} has expired" |
| Survey closed | Report "Survey {id} is closed" |
| Invalid question ID | Report valid question IDs |
| Invalid answer value | Report valid option values |
| Duplicate survey ID | Report "Survey {id} already exists" |
| Invalid JSON | Report parse error |
