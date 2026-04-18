---
name: survey
description: Lightweight survey/polling system for collecting feedback from specified users via interactive cards. Use when user mentions "调查", "投票", "问卷", "survey", "poll", "收集反馈", "意见收集". Supports single choice, multiple choice, and text questions with result aggregation.
allowed-tools: [Bash, Read, Write]
---

# Survey / Polling Skill

A lightweight in-bot survey system for collecting structured feedback from specified users via interactive Feishu cards.

## Single Responsibility

- ✅ Create surveys with custom questions (single choice, multiple choice, text)
- ✅ Send interactive survey cards to target users
- ✅ Record and aggregate responses
- ✅ Display survey results with statistics
- ✅ Close surveys manually or by deadline
- ❌ DO NOT implement external survey services (Feishu Survey API, third-party tools)
- ❌ DO NOT manage user authentication or permissions beyond target user lists

## Supported Question Types

| Type | Description | UI Component |
|------|-------------|--------------|
| `single_choice` | Select one option | Button group |
| `multiple_choice` | Select multiple options | Multi-select buttons |
| `text` | Free-form text input | Follow-up message |

## Usage

```
/survey create     — Create a new survey interactively
/survey results    — View results of a survey
/survey close      — Close a survey early
```

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Workflow

### Creating a Survey

When a user asks to create a survey/poll:

1. **Gather requirements** — Ask the user for:
   - Survey title
   - Description/purpose
   - Target users (Feishu open IDs or group mention)
   - Questions with types and options
   - Deadline (optional, default: 7 days)
   - Anonymous or not (default: not anonymous)

2. **Generate survey ID** — Use a descriptive kebab-case ID (e.g., `restaurant-review-2026-04`)

3. **Create survey file** using the create script:

```bash
SURVEY_ID="my-survey" \
SURVEY_TITLE="Restaurant Review" \
SURVEY_DESCRIPTION="Please rate our team lunch restaurant" \
SURVEY_EXPIRES_AT="2026-04-25T12:00:00Z" \
SURVEY_TARGET_USERS='["ou_user1","ou_user2"]' \
SURVEY_QUESTIONS='[
  {"id":"q1","type":"single_choice","question":"Taste rating","options":[
    {"id":"opt1","label":"⭐ Excellent"},
    {"id":"opt2","label":"👍 Good"},
    {"id":"opt3","label":"👌 Average"},
    {"id":"opt4","label":"👎 Poor"}
  ],"required":true},
  {"id":"q2","type":"text","question":"Any suggestions?","required":false}
]' \
npx tsx skills/survey/create.ts
```

4. **Send survey cards** to each target user. Build a card per question:

For **single_choice** questions, use button groups:

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"tag": "plain_text", "content": "📊 Survey: Restaurant Review"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "**Q1: Taste rating**\nPlease select your rating (1/2)"},
    {"tag": "hr"},
    {"tag": "action", "actions": [
      {"tag": "button", "text": {"tag": "plain_text", "content": "⭐ Excellent"}, "value": {"action": "survey_my-survey_q1_opt1"}, "type": "primary"},
      {"tag": "button", "text": {"tag": "plain_text", "content": "👍 Good"}, "value": {"action": "survey_my-survey_q1_opt2"}, "type": "default"},
      {"tag": "button", "text": {"tag": "plain_text", "content": "👌 Average"}, "value": {"action": "survey_my-survey_q1_opt3"}, "type": "default"},
      {"tag": "button", "text": {"tag": "plain_text", "content": "👎 Poor"}, "value": {"action": "survey_my-survey_q1_opt4"}, "type": "danger"}
    ]}
  ],
  "chatId": "<target_chat_id>",
  "actionPrompts": {
    "survey_my-survey_q1_opt1": "[Survey Response] my-survey: q1=opt1 from ou_xxx",
    "survey_my-survey_q1_opt2": "[Survey Response] my-survey: q1=opt2 from ou_xxx",
    "survey_my-survey_q1_opt3": "[Survey Response] my-survey: q1=opt3 from ou_xxx",
    "survey_my-survey_q1_opt4": "[Survey Response] my-survey: q1=opt4 from ou_xxx"
  }
}
```

For **text** questions, ask the user to reply with their answer and record it.

5. **Record responses** when users interact:

When you receive a `[Survey Response]` message:

```bash
SURVEY_ID="my-survey" \
SURVEY_RESPONDENT="ou_user1" \
SURVEY_ANSWERS='{"q1":"opt2"}' \
npx tsx skills/survey/respond.ts
```

### Viewing Results

```bash
SURVEY_ID="my-survey" npx tsx skills/survey/results.ts
```

Format results as a readable card:

```
📊 Survey Results: Restaurant Review
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Respondents: 3/5 (60% completion)

Q1: Taste rating
  ⭐ Excellent: 1 (33%)
  👍 Good: 2 (67%)
  👌 Average: 0 (0%)
  👎 Poor: 0 (0%)

Q2: Any suggestions?
  - "Add more vegetarian options"
  - "Love the spicy dishes!"
```

### Closing a Survey

```bash
SURVEY_ID="my-survey" npx tsx skills/survey/close.ts
```

## Data Storage

Survey files are stored in `workspace/surveys/` as JSON files:

```
workspace/surveys/
├── my-survey.json       # Survey definition + all responses
├── team-poll.json       # Another survey
└── ...
```

Each file contains the survey definition, questions, and all responses in a single JSON file.

## Important Rules

1. **Target user validation**: All target users must be valid Feishu open IDs (`ou_xxxxx` format)
2. **One response per user**: Unless anonymous, each user can only respond once
3. **Required questions**: Users must answer all required questions
4. **Expiry**: Surveys automatically expire at their `expiresAt` time (enforced at response time)
5. **Anonymous mode**: When anonymous, respondent IDs are replaced with random IDs
6. **Action value format**: Button action values use format `survey_{surveyId}_{questionId}_{optionId}`

## Limitations

- Max 20 questions per survey
- Max 10 options per choice question
- Max 100 target users per survey
- Max 2000 chars per text answer
- No branching logic or conditional questions
- No partial save — all questions must be answered at once
