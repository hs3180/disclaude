---
name: survey
description: Survey/Polling management - create, distribute, collect, and aggregate user feedback surveys. Use when user says keywords like "调查", "投票", "问卷", "survey", "poll", "/survey create|query|list|results". Supports single choice, multiple choice, and open text questions with optional anonymous mode and deadline enforcement.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Survey Manager

Manage lightweight surveys for collecting feedback from specified users via Feishu interactive cards (Issue #2191, Approach C: built-in lightweight survey).

Each survey is a JSON file in `workspace/surveys/`. Surveys are distributed using the existing `send_interactive` MCP tool.

## Single Responsibility

- ✅ Create survey files (active state)
- ✅ Query survey status and details
- ✅ List surveys with filters
- ✅ Submit user responses
- ✅ Aggregate and display results
- ✅ Generate results cards for visualization
- ❌ DO NOT send survey questions to users (use `send_interactive` MCP tool directly)
- ❌ DO NOT create groups or channels (use `chat` skill if needed)
- ❌ DO NOT auto-close expired surveys (handled by consumer/schedule)

## Invocation Modes

### Mode 1: Agent Invocation (Primary)

Called by agents that need to collect feedback from users:

```
Agent → calls this Skill → creates survey file → sends questions via send_interactive
```

### Mode 2: Direct User Invocation

```
/survey create          — Create a new survey
/survey query {id}      — Query survey status
/survey list             — List all surveys (optional --status filter)
/survey results {id}    — Show aggregated results
```

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Survey File Format

Each survey is a single JSON file in `workspace/surveys/`:

```json
{
  "id": "team-satisfaction-2026",
  "title": "Team Satisfaction Survey",
  "status": "active",
  "anonymous": false,
  "createdAt": "2026-04-26T10:00:00Z",
  "expiresAt": "2026-04-28T10:00:00Z",
  "closedAt": null,
  "questions": [
    {
      "id": "q1",
      "type": "single_choice",
      "text": "How satisfied are you with our service?",
      "options": ["Very Satisfied", "Satisfied", "Neutral", "Dissatisfied"]
    },
    {
      "id": "q2",
      "type": "multiple_choice",
      "text": "Which areas need improvement?",
      "options": ["Speed", "Quality", "Communication", "Documentation"]
    },
    {
      "id": "q3",
      "type": "open_text",
      "text": "Any additional comments?"
    }
  ],
  "targetUsers": ["ou_user1", "ou_user2"],
  "originChatId": "oc_xxx",
  "responses": {}
}
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique survey identifier (used as filename: `{id}.json`) |
| `title` | Yes | Survey title (max 128 chars) |
| `status` | Yes | `active` → `closed` / `expired` |
| `anonymous` | Yes | Whether responses are anonymous (boolean) |
| `createdAt` | Yes | ISO 8601 timestamp |
| `expiresAt` | Yes | ISO 8601 UTC Z-suffix deadline timestamp |
| `closedAt` | No | ISO 8601 timestamp (set when manually closed) |
| `questions` | Yes | Array of question objects (1-20 questions) |
| `targetUsers` | Yes | Array of target user open IDs |
| `originChatId` | No | Chat ID where survey was created (for sending results) |
| `responses` | Yes | Map of userId → response objects |

### Question Types

| Type | Description | Options Required |
|------|-------------|-----------------|
| `single_choice` | User selects one option | Yes |
| `multiple_choice` | User selects multiple options | Yes |
| `open_text` | User types free-form text | No |

### Response Format

```json
{
  "responses": {
    "ou_user1": {
      "respondedAt": "2026-04-26T12:00:00Z",
      "answers": {
        "q1": "Very Satisfied",
        "q2": ["Speed", "Quality"],
        "q3": "Great work overall!"
      }
    }
  }
}
```

## Operations

All scripts accept input via **environment variables** and are located in `skills/survey/`. Scripts include built-in survey ID validation (path traversal protection), file locking, and native JSON validation.

### 1. Create Survey

**Usage**: `/survey create`

```bash
SURVEY_ID="team-satisfaction-2026" \
SURVEY_TITLE="Team Satisfaction Survey" \
SURVEY_EXPIRES_AT="2026-04-28T10:00:00Z" \
SURVEY_ANONYMOUS="false" \
SURVEY_TARGET_USERS='["ou_user1", "ou_user2"]' \
SURVEY_QUESTIONS='[
  {"id": "q1", "type": "single_choice", "text": "How satisfied are you?", "options": ["Very", "OK", "Not great"]},
  {"id": "q2", "type": "open_text", "text": "Comments?"}
]' \
SURVEY_ORIGIN_CHAT="oc_xxx" \
npx tsx skills/survey/create.ts
```

**Validation** (built into script):
- `SURVEY_ID` must match `^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$` and pass path traversal check
- `SURVEY_EXPIRES_AT` must be UTC Z-suffix ISO 8601 format
- `SURVEY_TARGET_USERS` must be a non-empty JSON array of `ou_xxxxx` open IDs (max 100)
- `SURVEY_QUESTIONS` must be a non-empty JSON array (max 20 questions, max 20 options each)
- Question IDs must match `q<N>` pattern (e.g. `q1`, `q2`)
- Uniqueness checked under exclusive file lock
- File written atomically via `writeFile` + `rename`

### 2. Query Survey

**Usage**: `/survey query {id}`

```bash
SURVEY_ID="team-satisfaction-2026" npx tsx skills/survey/query.ts
```

Output is the raw JSON survey file. Display in readable format:

```
📋 Survey: team-satisfaction-2026
> **Title**: Team Satisfaction Survey
> **Status**: 🟢 Active
> **Anonymous**: No
> **Created**: 2026-04-26 10:00
> **Expires**: 2026-04-28 10:00
> **Target Users**: 3
> **Responses**: 1/3 (33%)
> **Questions**: 2
```

### 3. List Surveys

**Usage**: `/survey list [--status active|closed|expired]`

```bash
# List all surveys
npx tsx skills/survey/list.ts

# Filter by status
SURVEY_STATUS="active" npx tsx skills/survey/list.ts
```

Display in table format:

```
📂 Surveys

| ID | Title | Status | Responses | Expires |
|----|-------|--------|-----------|---------|
| team-satisfaction-2026 | Team Satisfaction | 🟢 Active | 1/3 (33%) | 04-28 10:00 |
| food-review-2026 | Restaurant Review | 🔴 Closed | 5/5 (100%) | 04-25 08:00 |
```

### 4. Submit Response

**Usage**: When a user responds to a survey question (via card button or text).

```bash
SURVEY_ID="team-satisfaction-2026" \
SURVEY_USER_ID="ou_user1" \
SURVEY_ANSWERS='{"q1": "Very Satisfied", "q2": ["Speed", "Quality"]}' \
npx tsx skills/survey/submit-response.ts
```

**Validation**:
- User must be a target user of the survey
- Survey must be in `active` status
- Answers are validated against question types
- Single choice: answer must be a valid option string
- Multiple choice: answer must be an array of valid options
- Open text: answer must be a non-empty string (max 2000 chars)
- Responses are upsert (re-submitting overwrites previous response)

### 5. Results

**Usage**: `/survey results {id}`

```bash
SURVEY_ID="team-satisfaction-2026" npx tsx skills/survey/results.ts
```

Output is a JSON results summary:

```json
{
  "surveyId": "team-satisfaction-2026",
  "title": "Team Satisfaction Survey",
  "status": "active",
  "totalTargetUsers": 3,
  "totalResponses": 2,
  "responseRate": 67,
  "expiresAt": "2026-04-28T10:00:00Z",
  "questions": [
    {
      "questionId": "q1",
      "questionText": "How satisfied are you?",
      "type": "single_choice",
      "totalResponses": 2,
      "options": [
        {"label": "Very Satisfied", "count": 1, "percentage": 50},
        {"label": "Satisfied", "count": 1, "percentage": 50}
      ]
    },
    {
      "questionId": "q2",
      "questionText": "Comments?",
      "type": "open_text",
      "totalResponses": 1,
      "responses": [
        {"userId": "ou_user1", "text": "Great work!"}
      ]
    }
  ]
}
```

**Display format**:

```
📊 Results: Team Satisfaction Survey
> **Response Rate**: 2/3 (67%)
> **Deadline**: 2026-04-28 10:00

### Q1: How satisfied are you? (2 responses)
- Very Satisfied: ████████████ 50% (1)
- Satisfied:     ████████████ 50% (1)

### Q2: Comments? (1 response)
- ou_user1: "Great work!"
```

## Survey Distribution Workflow

After creating a survey, distribute questions to each target user using `send_interactive`:

### For Choice Questions (single_choice / multiple_choice)

```
For each target user:
  For each question:
    1. send_interactive({
         question: "Q1: How satisfied are you?",
         options: [
           { text: "Very Satisfied", value: "q1_Very Satisfied" },
           { text: "Satisfied", value: "q1_Satisfied" },
           { text: "Neutral", value: "q1_Neutral" },
         ],
         title: "📋 Team Satisfaction Survey",
         chatId: "<user_chat_id>",
         actionPrompts: {
           "q1_Very Satisfied": "[survey:survey-id:q1] User answered 'Very Satisfied'",
           "q1_Satisfied": "[survey:survey-id:q1] User answered 'Satisfied'",
           "q1_Neutral": "[survey:survey-id:q1] User answered 'Neutral'",
         }
       })
    2. When user clicks button → agent receives prompt
    3. Agent calls submit-response.ts to record the answer
```

### For Open Text Questions

```
For each target user:
  For each open_text question:
    1. send_text({ text: "📋 Q3: Any additional comments? (Please reply with your answer)", chatId: "<user_chat_id>" })
    2. User types response → agent receives message
    3. Agent calls submit-response.ts to record the answer
```

### Important Notes on Distribution

- **One card per question**: Send each question as a separate interactive card for clarity
- **Action prompt format**: `[survey:{surveyId}:{questionId}] User answered '{option}'` enables the agent to identify and process survey responses
- **User identification**: The Sender Open ID from card callbacks identifies the respondent
- **1-on-1 chat**: If target users are in a group, send to each user individually or use the group chat with clear addressing

## Lifecycle States

```
┌───────────┐  All responses     ┌──────────┐
│   active  │  received or       │  closed  │
│  收集中   │  manual close      │  已关闭  │
└─────┬─────┘                    └──────────┘
      │
      │ deadline passed
      ▼
┌──────────┐
│  expired │
│  已过期  │
└──────────┘
```

| Status | Meaning | Trigger | Who Sets |
|--------|---------|---------|----------|
| `active` | Accepting responses | Survey created | **This Skill** |
| `closed` | No more responses | Manual close or all responses received | **Consumer** |
| `expired` | Deadline passed | Schedule detects expired survey | **Schedule** |

## Survey Directory

```
workspace/surveys/
├── team-satisfaction-2026.json   # Team satisfaction survey
├── food-review-2026.json        # Restaurant review
└── project-feedback.json        # Project feedback survey
```

## DO NOT

- ❌ Send survey questions directly (use `send_interactive` MCP tool)
- ❌ Create or dissolve groups (use `chat` skill if needed)
- ❌ Auto-close surveys without user confirmation
- ❌ Delete survey files manually
- ❌ Use YAML format (always JSON)
- ❌ Manually delete `.lock` files
- ❌ Record responses for non-target users

## Error Handling

| Scenario | Action |
|----------|--------|
| Survey file not found | Report "Survey {id} not found" |
| Survey already closed/expired | Report "Survey {id} is {status}, cannot accept responses" |
| User not a target | Report "User is not a target for this survey" |
| Invalid answer for question type | Report "Invalid answer for question {qId}" |
| Duplicate survey ID | Report "Survey {id} already exists" |
| Invalid survey ID (path traversal) | Report "Invalid survey ID" and reject immediately |
| Invalid JSON in answers | Report "SURVEY_ANSWERS must be valid JSON" |
| Node.js not available | Exit with error (required runtime) |

## Example: Restaurant Review Survey

### Agent Creates Survey

```bash
SURVEY_ID="food-review-2026-04" \
SURVEY_TITLE="Restaurant Review: Sichuan Garden" \
SURVEY_EXPIRES_AT="2026-04-28T18:00:00Z" \
SURVEY_ANONYMOUS="false" \
SURVEY_TARGET_USERS='["ou_alice", "ou_bob", "ou_charlie"]' \
SURVEY_QUESTIONS='[
  {"id": "q1", "type": "single_choice", "text": "How would you rate the taste?", "options": ["5 - Excellent", "4 - Good", "3 - Average", "2 - Below Average", "1 - Poor"]},
  {"id": "q2", "type": "single_choice", "text": "How would you rate the environment?", "options": ["5 - Excellent", "4 - Good", "3 - Average", "2 - Below Average", "1 - Poor"]},
  {"id": "q3", "type": "multiple_choice", "text": "What did you like most?", "options": ["Spiciness", "Portion Size", "Freshness", "Price", "Service"]},
  {"id": "q4", "type": "open_text", "text": "Any dishes you would recommend?"}
]' \
SURVEY_ORIGIN_CHAT="oc_team_group" \
npx tsx skills/survey/create.ts
```

### Agent Distributes Questions

For each target user, send interactive cards for each choice question and text prompts for open questions.

### User Responds

User clicks button on card → agent receives action prompt → agent records response:

```bash
SURVEY_ID="food-review-2026-04" \
SURVEY_USER_ID="ou_alice" \
SURVEY_ANSWERS='{"q1": "5 - Excellent", "q2": "4 - Good", "q3": ["Spiciness", "Portion Size"], "q4": "The mapo tofu is amazing!"}' \
npx tsx skills/survey/submit-response.ts
```

### Agent Shows Results

```bash
SURVEY_ID="food-review-2026-04" npx tsx skills/survey/results.ts
```

Then use `send_card` to display a visual results card to the origin chat.
