---
name: survey
description: Survey/Poll creator - create lightweight surveys and polls with card-based interaction. Use when user wants to create a poll, collect feedback, run a vote, or says keywords like "调查", "投票", "问卷", "survey", "poll", "投票功能", "收集反馈".
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Survey / Poll Creator

Create lightweight surveys and polls using Feishu interactive cards for feedback collection.

## When to Use This Skill

**Use this skill for:**
- Creating surveys/polls to collect feedback from specific users
- Running votes on decisions (e.g., restaurant choice, activity planning)
- Collecting ratings or preferences from team members
- Any scenario requiring structured feedback from multiple people

**Keywords that trigger this skill**: "调查", "投票", "问卷", "survey", "poll", "收集反馈", "投票功能", "vote"

## Core Principle

**Card-based interaction, file-backed storage.**

Surveys are stored as JSON files in `workspace/surveys/`. Interactive cards with buttons are sent to participants for easy one-click responses.

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
  "id": "restaurant-vote-2026",
  "status": "open",
  "title": "团建餐厅投票",
  "description": "请大家为本月团建活动投票选择餐厅",
  "questions": [
    {
      "text": "你最喜欢哪家餐厅？",
      "type": "single_choice",
      "options": ["川味坊", "粤菜轩", "日式料理", "西餐厅"],
      "required": true
    }
  ],
  "participants": ["ou_user1", "ou_user2"],
  "anonymous": false,
  "createdAt": "2026-04-22T10:00:00Z",
  "deadline": "2026-04-25T10:00:00Z",
  "closedAt": null,
  "responses": []
}
```

## Operations

### 1. Create Survey

**Usage**: User asks to create a survey/poll.

```bash
SURVEY_ID="restaurant-vote-2026" \
SURVEY_TITLE="团建餐厅投票" \
SURVEY_DESCRIPTION="请大家投票选择团建餐厅" \
SURVEY_QUESTIONS='[{"text":"你最喜欢哪家？","type":"single_choice","options":["A","B","C"],"required":true}]' \
SURVEY_PARTICIPANTS='["ou_user1","ou_user2"]' \
SURVEY_ANONYMOUS="false" \
SURVEY_DEADLINE="2026-04-25T10:00:00Z" \
npx tsx skills/survey/create.ts
```

**Validation** (built into script):
- `SURVEY_ID`: alphanumeric + hyphens, no leading dots, path traversal safe
- `SURVEY_QUESTIONS`: JSON array, max 10 questions, each with text + type + options
- `SURVEY_PARTICIPANTS`: non-empty array of `ou_xxxxx` open IDs, max 50
- `SURVEY_DEADLINE`: UTC Z-suffix ISO 8601 format

### 2. Send Survey Cards

After creating the survey, send interactive cards to participants. For each question, build a card with option buttons:

Use `send_interactive` MCP tool to send a card per question:

```
send_interactive({
  question: "你最喜欢哪家餐厅？",
  title: "团建餐厅投票",
  options: [
    { text: "川味坊", value: "survey:restaurant-vote-2026:0:川味坊", type: "primary" },
    { text: "粤菜轩", value: "survey:restaurant-vote-2026:0:粤菜轩", type: "default" },
    { text: "日式料理", value: "survey:restaurant-vote-2026:0:日式料理", type: "default" },
    { text: "西餐厅", value: "survey:restaurant-vote-2026:0:西餐厅", type: "default" },
  ],
  context: "请投票选择 | 截止: 2026-04-25",
  chatId: "{chatId}",
  actionPrompts: {
    "survey:restaurant-vote-2026:0:川味坊": "[投票] 用户选择了 川味坊，请使用 survey skill 记录投票: SURVEY_ID=restaurant-vote-2026 SURVEY_RESPONDER={{senderOpenId}} SURVEY_ANSWERS='{\"0\":\"川味坊\"}' npx tsx skills/survey/respond.ts",
    "survey:restaurant-vote-2026:0:粤菜轩": "[投票] 用户选择了 粤菜轩，请使用 survey skill 记录投票: SURVEY_ID=restaurant-vote-2026 SURVEY_RESPONDER={{senderOpenId}} SURVEY_ANSWERS='{\"0\":\"粤菜轩\"}' npx tsx skills/survey/respond.ts",
    "survey:restaurant-vote-2026:0:日式料理": "[投票] 用户选择了 日式料理，请使用 survey skill 记录投票: SURVEY_ID=restaurant-vote-2026 SURVEY_RESPONDER={{senderOpenId}} SURVEY_ANSWERS='{\"0\":\"日式料理\"}' npx tsx skills/survey/respond.ts",
    "survey:restaurant-vote-2026:0:西餐厅": "[投票] 用户选择了 西餐厅，请使用 survey skill 记录投票: SURVEY_ID=restaurant-vote-2026 SURVEY_RESPONDER={{senderOpenId}} SURVEY_ANSWERS='{\"0\":\"西餐厅\"}' npx tsx skills/survey/respond.ts",
  }
})
```

**Action Value Format**: `survey:{surveyId}:{questionIndex}:{optionText}`

This format ensures each button maps to a specific survey question and option, and the action prompt provides clear instructions for recording the vote.

**Note**: The `{{senderOpenId}}` placeholder is NOT a standard action prompt template variable. When recording responses, use the Sender Open ID from the user's context message.

### 3. Record Response

When a participant clicks a button, the action prompt instructs you to record the vote:

```bash
SURVEY_ID="restaurant-vote-2026" \
SURVEY_RESPONDER="ou_user1" \
SURVEY_ANSWERS='{"0": "川味坊"}' \
npx tsx skills/survey/respond.ts
```

**Idempotency**: Each participant can only respond once (unless anonymous survey). Duplicate responses are rejected.

### 4. Query Survey Status

```bash
SURVEY_ID="restaurant-vote-2026" npx tsx skills/survey/query.ts
```

Output includes:
- Status (open/closed/expired)
- Response count and participation rate
- Per-question vote breakdown
- List of pending respondents (if not anonymous)

### 5. Get Results

```bash
SURVEY_ID="restaurant-vote-2026" npx tsx skills/survey/results.ts
```

Returns JSON with aggregated results:
- Per-question option counts and percentages
- Text answers for open-ended questions
- Participation statistics

### 6. Close Survey

```bash
SURVEY_ID="restaurant-vote-2026" npx tsx skills/survey/close.ts
```

Manually close an open survey before the deadline.

---

## Workflow: Creating a Survey

When a user asks to create a survey, follow these steps:

### Step 1: Gather Requirements

Ask the user for:
1. **Survey title** (required)
2. **Questions** — what to ask, what type (single choice, multiple choice, text)
3. **Options** — for choice questions, what options to provide
4. **Participants** — who to send to (open IDs or names if known)
5. **Deadline** — when the survey closes
6. **Anonymous** — whether responses should be anonymous (default: no)

### Step 2: Create Survey File

Generate a unique survey ID (format: `{topic}-{date}`, e.g., `restaurant-vote-2026-04-22`).

Run `create.ts` with the gathered parameters.

### Step 3: Send Survey Cards

For each question:
1. Build interactive card options using the action value format: `survey:{surveyId}:{questionIndex}:{option}`
2. Create action prompts that instruct the agent to record the response
3. Use `send_interactive` to send the card to the chat

For **text questions**, send a regular message asking the question, and handle the response by recording it manually:

```bash
SURVEY_ID="survey-id" \
SURVEY_RESPONDER="ou_xxx" \
SURVEY_ANSWERS='{"1": "user typed response here"}' \
npx tsx skills/survey/respond.ts
```

### Step 4: Monitor and Close

- Use `query.ts` to check status
- When the deadline passes or user requests, use `close.ts`
- Use `results.ts` to generate the final report
- Send results back to the chat as a formatted card

---

## Survey Directory

```
workspace/surveys/
├── restaurant-vote-2026.json
├── team-satisfaction-2026-04.json
└── activity-preference-spring.json
```

## Question Types (Phase 1)

| Type | Description | Card Interaction |
|------|-------------|------------------|
| `single_choice` | One option from list | Buttons (one per option) |
| `multiple_choice` | Multiple options from list | Multiple card sends or instruction |
| `text` | Free-form text answer | No card; agent records typed response |

## Example: Restaurant Vote

### User Request
> "帮我发起一个投票，让大家选下周团建的餐厅，选项有川味坊、粤菜轩、日式料理"

### Agent Actions

1. **Create survey**:
```bash
SURVEY_ID="restaurant-vote-2026-04-22" \
SURVEY_TITLE="团建餐厅投票" \
SURVEY_DESCRIPTION="下周团建餐厅选择" \
SURVEY_QUESTIONS='[{"text":"你最想哪家餐厅？","type":"single_choice","options":["川味坊","粤菜轩","日式料理"],"required":true}]' \
SURVEY_PARTICIPANTS='["ou_user1","ou_user2","ou_user3"]' \
SURVEY_DEADLINE="2026-04-25T10:00:00Z" \
npx tsx skills/survey/create.ts
```

2. **Send card** to the chat with interactive buttons for each restaurant option.

3. **When user clicks** a button, the action prompt triggers:
```bash
SURVEY_ID="restaurant-vote-2026-04-22" \
SURVEY_RESPONDER="ou_user1" \
SURVEY_ANSWERS='{"0":"川味坊"}' \
npx tsx skills/survey/respond.ts
```

4. **Show results** when requested or after deadline:
```bash
SURVEY_ID="restaurant-vote-2026-04-22" npx tsx skills/survey/results.ts
```

5. **Send results card** with vote counts and percentages.

---

## DO NOT

- ❌ Send surveys to users not in the participants list
- ❌ Modify responses after they are recorded
- ❌ Reveal individual responses for anonymous surveys
- ❌ Create surveys without a deadline
- ❌ Delete survey files manually
- ❌ Use YAML format (always JSON)
- ❌ Use `Closes #2191` in PRs (this is Phase 1, not complete)
