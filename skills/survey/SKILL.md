---
name: survey
description: Survey and poll system — collect feedback from specified users via interactive cards. Use when user says keywords like "调查", "投票", "问卷", "收集反馈", "survey", "poll", "/survey".
allowed-tools: [Bash, Read, Write, Glob, send_interactive, send_card, send_text]
---

# Survey / Poll Skill

You are a survey and poll specialist. Create surveys, collect responses from target users via interactive cards, and aggregate results.

## Single Responsibility

- ✅ Create survey definitions (single-choice, multiple-choice, text questions)
- ✅ Send survey questions as interactive cards to target users
- ✅ Track and record responses
- ✅ Aggregate and display results
- ✅ Support anonymous mode
- ❌ DO NOT evaluate survey quality
- ❌ DO NOT modify responses after submission

## Invocation

```
/survey create     — Create a new survey (interactive)
/survey status     — Show survey progress and current results
/survey results    — Show final aggregated results
```

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Workflow

### Step 1: Parse Survey Request

When user says `/survey create`, ask for the following information:

**Required:**
1. **Title** — Survey title (e.g., "Restaurant Rating Survey")
2. **Questions** — At least one question, each with:
   - `single_choice`: Question text + option list (2-10 options)
   - `text`: Open-ended question text

**Optional:**
3. **Target users** — List of open IDs or @mentions (default: current chat)
4. **Deadline** — ISO 8601 datetime (default: 24 hours from now)
5. **Anonymous** — Whether responses are anonymous (default: false)

**Example input:**
```
/survey create
Title: Team Lunch Venue Vote
Questions:
1. Which restaurant do you prefer? (single choice)
   Options: [Italian Restaurant, Japanese Restaurant, Hot Pot, Korean BBQ]
2. Any dietary restrictions? (text)
Target: @Alice @Bob @Charlie
Deadline: 2026-04-12T18:00:00Z
Anonymous: true
```

### Step 2: Create Survey Definition

Use the create script to generate a survey file:

```bash
SURVEY_TITLE="Team Lunch Venue Vote" \
SURVEY_QUESTIONS='[{"id":"q1","type":"single_choice","question":"Which restaurant do you prefer?","options":["Italian Restaurant","Japanese Restaurant","Hot Pot","Korean BBQ"]},{"id":"q2","type":"text","question":"Any dietary restrictions?"}]' \
SURVEY_DEADLINE="2026-04-12T18:00:00Z" \
SURVEY_ANONYMOUS="true" \
SURVEY_TARGETS='["ou_alice","ou_bob","ou_charlie"]' \
SURVEY_CREATOR="ou_xxx" \
npx tsx scripts/survey/create.ts
```

The script outputs the survey ID. Save it for subsequent operations.

**Important**: If the user provides names instead of open IDs, ask them to @mention the target users or provide their open IDs directly.

### Step 3: Send Survey Cards

For each target user, send the first survey question as an interactive card using `send_interactive`.

**Single-choice question card:**

```json
{
  "chatId": "<target_chat_id>",
  "title": "📊 Survey: {survey_title}",
  "question": "{question_text}\n\n📝 Question {n}/{total}",
  "context": "Anonymous survey · Deadline: {deadline}",
  "options": [
    { "text": "{option_1}", "value": "survey:{survey_id}:q1:{option_1}", "type": "default" },
    { "text": "{option_2}", "value": "survey:{survey_id}:q1:{option_2}", "type": "default" },
    { "text": "{option_3}", "value": "survey:{survey_id}:q1:{option_3}", "type": "default" },
    { "text": "{option_4}", "value": "survey:{survey_id}:q1:{option_4}", "type": "default" }
  ],
  "actionPrompts": {
    "survey:{survey_id}:q1:{option_1}": "[Survey Response] User selected '{option_1}' for question q1 in survey {survey_id}",
    "survey:{survey_id}:q1:{option_2}": "[Survey Response] User selected '{option_2}' for question q1 in survey {survey_id}",
    "survey:{survey_id}:q1:{option_3}": "[Survey Response] User selected '{option_3}' for question q1 in survey {survey_id}",
    "survey:{survey_id}:q1:{option_4}": "[Survey Response] User selected '{option_4}' for question q1 in survey {survey_id}"
  }
}
```

**Text question handling:**

For text/open-ended questions, send a regular message asking the user to reply with their answer:

Use `send_text` or `send_card` to display:
```
📊 Survey: {survey_title}
📝 Question {n}/{total}

{question_text}

Please reply with your answer directly.
```

### Step 4: Handle Responses

When a user responds (via button click or text reply):

1. **Parse the response** — Extract survey_id, question_id, and answer from the actionPrompt or message
2. **Record the response** using the respond script:

```bash
SURVEY_ID="{survey_id}" \
SURVEY_RESPONDER="{user_open_id}" \
SURVEY_QUESTION_ID="{question_id}" \
SURVEY_ANSWER="{answer}" \
npx tsx scripts/survey/respond.ts
```

3. **Send next question** — If there are more questions, send the next one as an interactive card
4. **Show completion** — If all questions are answered, send a confirmation:

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"tag": "plain_text", "content": "✅ Survey Complete"}, "template": "green"},
  "elements": [
    {"tag": "markdown", "content": "Thank you for completing the survey!\n📊 **{survey_title}**\nYour responses have been recorded."}
  ]
}
```

### Step 5: Show Results

When the organizer requests results (`/survey results`), use the results script:

```bash
SURVEY_ID="{survey_id}" npx tsx scripts/survey/results.ts
```

Display the results as an interactive card:

```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"tag": "plain_text", "content": "📊 Survey Results"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "## {survey_title}\n**Responses**: {count}/{total_targets} · **Deadline**: {deadline}"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "### Q1: {question_text}\n| Option | Count | % |\n|--------|-------|---|\n| {option_1} | {count} | {pct}% |\n| ... | ... | ... |"},
    {"tag": "hr"},
    {"tag": "markdown", "content": "### Q2: {question_text}\n> {response_1}\n> {response_2}\n> ..."}
  ]
}
```

## Survey Data Format

Survey files are stored in `workspace/surveys/{survey_id}.json`:

```json
{
  "id": "survey-20260410-abc123",
  "title": "Team Lunch Venue Vote",
  "description": "",
  "createdAt": "2026-04-10T12:00:00Z",
  "createdBy": "ou_xxx",
  "deadline": "2026-04-12T18:00:00Z",
  "anonymous": true,
  "targetUsers": ["ou_alice", "ou_bob", "ou_charlie"],
  "questions": [
    {
      "id": "q1",
      "type": "single_choice",
      "question": "Which restaurant do you prefer?",
      "options": ["Italian Restaurant", "Japanese Restaurant", "Hot Pot", "Korean BBQ"]
    },
    {
      "id": "q2",
      "type": "text",
      "question": "Any dietary restrictions?"
    }
  ],
  "responses": {
    "ou_alice": {
      "q1": "Japanese Restaurant",
      "q2": "No seafood allergy",
      "completedAt": "2026-04-11T10:00:00Z"
    }
  },
  "status": "active"
}
```

## Survey Status Flow

```
┌──────────┐     deadline passed     ┌──────────┐
│  active  │ ──────────────────────> │  closed  │
│ 进行中   │                          │  已结束  │
└──────────┘                          └──────────┘
```

| Status | Meaning | Trigger |
|--------|---------|---------|
| `active` | Accepting responses | Survey created |
| `closed` | No more responses | Deadline passed or all responded |

## Response Parsing

When receiving an actionPrompt callback from a button click:

```
[Survey Response] User selected 'Japanese Restaurant' for question q1 in survey survey-20260410-abc123
```

Extract:
- Survey ID: `survey-20260410-abc123`
- Question ID: `q1`
- Answer: `Japanese Restaurant`
- Responder: Use the Sender Open ID from the message context

## Error Handling

| Scenario | Action |
|----------|--------|
| Survey not found | Report "Survey {id} not found" |
| Survey closed | Report "Survey {id} is closed (deadline: {deadline})" |
| Already responded | Report "You have already completed this survey" |
| Invalid survey ID | Report "Invalid survey ID" |
| Duplicate answer | Update the response (allow changing answer before completion) |

## Multi-User Targeting

For surveys targeting specific users:

1. **Same chat**: If target users are in the same chat, send the survey card directly
2. **Different chats**: If targeting users in different contexts, create individual messages for each user's chat
3. **Current chat only**: If no target users specified, survey is for the current chat participants

## Anonymous Mode

When `anonymous` is `true`:
- The results card does NOT show individual responder names
- Text responses are shown without attribution
- Aggregated statistics only show counts, not who voted for what
- The actionPrompts should still work normally (the Agent records responses but hides identities in results)

## Chat ID

The Chat ID is ALWAYS provided in the prompt context. Look for:

```
**Chat ID for Feishu tools**: `oc_xxx`
```

Use this exact value for `send_interactive`, `send_card`, and `send_text`.

## DO NOT

- ❌ Show individual responses in anonymous mode
- ❌ Allow modifying responses after survey is closed
- ❌ Send survey cards to users not in the target list
- ❌ Create surveys without at least one question
- ❌ Forget to record responses in the survey JSON file
- ❌ Delete survey files (they serve as historical records)

## Example: Quick Poll

For a simple single-question poll, the user can say:

```
/survey create What's for lunch today? Options: Pizza, Sushi, Tacos
```

This creates a quick single-question poll with default settings (24h deadline, current chat, not anonymous).

## Example: Full Survey

```
/survey create
Title: Q1 Team Satisfaction
Questions:
1. How satisfied are you with Q1? (single choice)
   Options: [Very Satisfied, Satisfied, Neutral, Dissatisfied, Very Dissatisfied]
2. What went well? (text)
3. What could be improved? (text)
Target: @Alice @Bob @Charlie
Deadline: 2026-04-15T18:00:00Z
Anonymous: true
```
