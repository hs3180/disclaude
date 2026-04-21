---
name: survey
description: Survey/Polling feature - create and manage lightweight surveys to collect feedback from specified users. Use when user says keywords like "调查", "投票", "问卷", "survey", "poll", "收集反馈", "feedback collection".
allowed-tools: [Bash, Read, Write, Glob, Grep, send_interactive]
---

# Survey Manager

Create and manage lightweight surveys/polls to collect feedback from specified users via interactive cards.

Issue #2191: Built-in lightweight survey using cards + callbacks (Option C).

## When to Use This Skill

**Use this skill for:**
- Creating surveys/polls to collect feedback from team members
- Rating collection (restaurants, events, products)
- Quick team voting or decision-making
- Satisfaction surveys

**Keywords that trigger this skill**: "调查", "投票", "问卷", "survey", "poll", "收集反馈", "feedback", "投票功能"

## Single Responsibility

- ✅ Create survey files (active state)
- ✅ Record user responses
- ✅ Display aggregated results
- ✅ Close surveys
- ❌ DO NOT send messages to individual users (agent uses send_interactive directly)
- ❌ DO NOT manage user notification/reminders (future enhancement)

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Survey File Format

Each survey is a JSON file in `workspace/surveys/`:

```json
{
  "id": "restaurant-2026-04",
  "status": "active",
  "title": "Restaurant Rating Survey",
  "description": "How was the restaurant experience?",
  "createdAt": "2026-04-22T10:00:00Z",
  "expiresAt": "2026-04-25T10:00:00Z",
  "anonymous": false,
  "questions": [
    {
      "id": "q1",
      "type": "single_choice",
      "text": "Overall rating",
      "options": ["1⭐", "2⭐⭐", "3⭐⭐⭐", "4⭐⭐⭐⭐", "5⭐⭐⭐⭐⭐"]
    },
    {
      "id": "q2",
      "type": "multiple_choice",
      "text": "What did you like?",
      "options": ["口味", "环境", "服务", "性价比"],
      "maxSelections": 3
    },
    {
      "id": "q3",
      "type": "text",
      "text": "Any suggestions?"
    }
  ],
  "targetUsers": ["ou_user1", "ou_user2"],
  "responses": [],
  "closedAt": null
}
```

### Question Types

| Type | Description | Example |
|------|-------------|---------|
| `single_choice` | Pick one option | Rating 1-5, Yes/No |
| `multiple_choice` | Pick multiple options | What did you like? |
| `text` | Free-form text answer | Any suggestions? |

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique survey identifier (filename: `{id}.json`) |
| `status` | Yes | `active` or `closed` |
| `title` | Yes | Survey title (max 100 chars) |
| `description` | No | Survey description (max 500 chars) |
| `createdAt` | Yes | ISO 8601 Z-suffix timestamp |
| `expiresAt` | Yes | ISO 8601 Z-suffix expiry timestamp |
| `anonymous` | Yes | Whether responses are anonymous |
| `questions` | Yes | Array of 1-10 questions |
| `targetUsers` | Yes | Array of `ou_xxxxx` open IDs (1-50 users) |
| `responses` | Yes | Array of collected responses |
| `closedAt` | No | When survey was closed |

## Operations

### 1. Create Survey

**Usage**: `/survey create` or natural language "创建一个调查"

```bash
SURVEY_ID="restaurant-2026-04" \
SURVEY_TITLE="餐厅评价调查" \
SURVEY_DESCRIPTION="对上次聚餐的餐厅进行评价" \
SURVEY_EXPIRES_AT="2026-04-25T10:00:00Z" \
SURVEY_ANONYMOUS="false" \
SURVEY_QUESTIONS='[
  {"id":"q1","type":"single_choice","text":"整体评分","options":["1⭐","2⭐⭐","3⭐⭐⭐","4⭐⭐⭐⭐","5⭐⭐⭐⭐⭐"]},
  {"id":"q2","type":"text","text":"有什么建议？"}
]' \
SURVEY_TARGET_USERS='["ou_user1","ou_user2"]' \
npx tsx skills/survey/create.ts
```

**After creation**, send each choice question to target users via interactive cards:

For each **choice-type question**, use `send_interactive` to send to each target user individually:

```
send_interactive({
  question: "{question text}",
  options: [
    { text: "{option1}", value: "survey:{survey_id}:{question_id}:{option1}", type: "primary" },
    { text: "{option2}", value: "survey:{survey_id}:{question_id}:{option2}", type: "default" },
    ...
  ],
  title: "📊 {survey title}",
  context: "第 {n}/{total} 题",
  chatId: "{user_chat_id_or_group_chat_id}"
})
```

**IMPORTANT**: The `value` format is `survey:{survey_id}:{question_id}:{answer}` — this lets you parse the response when a user clicks a button.

For **text questions**, simply ask the user to reply with text. Record the response manually.

### 2. Record Response

When a user responds (clicks a button or sends text), record the response:

```bash
SURVEY_ID="restaurant-2026-04" \
SURVEY_RESPONDER="ou_user1" \
SURVEY_ANSWERS='{"q1":"5⭐⭐⭐⭐⭐","q2":"味道很好！"}' \
npx tsx skills/survey/respond.ts
```

**Parsing button click responses**:

When a user clicks a button with value `survey:restaurant-2026-04:q1:5⭐⭐⭐⭐⭐`, parse it:
- survey_id = `restaurant-2026-04`
- question_id = `q1`
- answer = `5⭐⭐⭐⭐⭐`

Then record using the respond.ts script.

### 3. View Results

```bash
SURVEY_ID="restaurant-2026-04" npx tsx skills/survey/results.ts
```

Display results in readable format:

```
📊 Survey: 餐厅评价调查
   Status: active | Responses: 3/5

📝 整体评分 (单选)
────────────────────────────────────────
   5⭐⭐⭐⭐⭐        ████████████████████ 2 (66.7%)
   4⭐⭐⭐⭐          ██████████ 1 (33.3%)
```

### 4. Close Survey

To manually close a survey before expiry:

```bash
# Read the survey file
cat workspace/surveys/{survey_id}.json

# Update the status field and closedAt, then write back
# Use jq or direct file manipulation:
SURVEY_FILE="workspace/surveys/{survey_id}.json"
cat "$SURVEY_FILE" | jq '.status = "closed" | .closedAt = "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"' > "${SURVEY_FILE}.tmp" && mv "${SURVEY_FILE}.tmp" "$SURVEY_FILE"
```

## Workflow

### Creating and Distributing a Survey

1. **Create** the survey file using create.ts
2. **Send questions** to each target user using `send_interactive` (one card per choice question)
3. **Collect responses** — when users click buttons, parse the value and record via respond.ts
4. **View results** anytime using results.ts
5. **Close** when done or let it expire naturally

### Response Handling Flow

```
User clicks button → value = "survey:survey-123:q1:5⭐⭐⭐⭐⭐"
    ↓
Parse value: survey_id=survey-123, question_id=q1, answer=5⭐⭐⭐⭐⭐
    ↓
Record: SURVEY_ID=survey-123 SURVEY_RESPONDER=ou_xxx SURVEY_ANSWERS='{"q1":"5⭐⭐⭐⭐⭐"}' npx tsx skills/survey/respond.ts
    ↓
Send next question card (if more questions remain)
```

## Survey Directory

```
workspace/surveys/
├── restaurant-2026-04.json       # Restaurant rating survey
├── team-vote-feature.json        # Feature voting poll
└── event-satisfaction.json       # Event feedback
```

## DO NOT

- ❌ Send all questions in a single card (one question per card for better UX)
- ❌ Create surveys without valid target user open IDs
- ❌ Modify survey files directly (use the scripts)
- ❌ Delete survey files manually
- ❌ Forget to validate survey IDs (path traversal protection)

## Error Handling

| Scenario | Action |
|----------|--------|
| Survey file not found | Report "Survey {id} not found" |
| Survey already closed | Report "Survey {id} is already closed" |
| Survey expired | Report "Survey {id} has expired" |
| User not in target list | Report "User is not a target of this survey" |
| Invalid survey ID | Report "Invalid survey ID" and reject |
| Duplicate response | Update existing response (allow re-submission) |
| Invalid answer | Report specific validation error |

## Example: Restaurant Rating Survey

### User Request

> "帮我创建一个对昨晚聚餐的餐厅评价调查，发给 @张三 @李四"

### Agent Steps

1. **Create survey file**:
```bash
SURVEY_ID="restaurant-$(date +%Y%m%d)" \
SURVEY_TITLE="聚餐餐厅评价" \
SURVEY_EXPIRES_AT="2026-04-25T10:00:00Z" \
SURVEY_QUESTIONS='[{"id":"q1","type":"single_choice","text":"整体满意度","options":["非常满意","满意","一般","不满意"]},{"id":"q2","type":"text","text":"有什么建议？"}]' \
SURVEY_TARGET_USERS='["ou_zhangsan","ou_lisi"]' \
npx tsx skills/survey/create.ts
```

2. **Send question cards** to each user via `send_interactive`:
```
# Send q1 to 张三
send_interactive({
  question: "整体满意度",
  options: [
    {text: "非常满意", value: "survey:restaurant-20260422:q1:非常满意", type: "primary"},
    {text: "满意", value: "survey:restaurant-20260422:q1:满意", type: "default"},
    {text: "一般", value: "survey:restaurant-20260422:q1:一般", type: "default"},
    {text: "不满意", value: "survey:restaurant-20260422:q1:不满意", type: "danger"}
  ],
  title: "📊 聚餐餐厅评价",
  context: "第 1/2 题",
  chatId: "{zhangsan_chat_id}"
})
```

3. **When users respond**, parse and record:
```bash
SURVEY_ID="restaurant-20260422" \
SURVEY_RESPONDER="ou_zhangsan" \
SURVEY_ANSWERS='{"q1":"非常满意"}' \
npx tsx skills/survey/respond.ts
```

4. **Show results** when requested:
```bash
SURVEY_ID="restaurant-20260422" npx tsx skills/survey/results.ts
```
