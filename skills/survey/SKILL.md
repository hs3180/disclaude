---
name: survey
description: Survey/polling tool - create and manage lightweight surveys to collect feedback from specified users. Use when user says keywords like "survey", "调查", "投票", "poll", "问卷", "收集反馈", "feedback collection", "/survey create", "/survey results", "/survey list".
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Survey Manager

Create and manage lightweight surveys using Feishu interactive cards. Supports single-choice questions with result aggregation.

## Capabilities

- ✅ Create surveys with multiple single-choice questions
- ✅ Target specific users via open IDs
- ✅ Anonymous option (hide responder identities in results)
- ✅ Deadline enforcement (auto-expire)
- ✅ Allow response changes (last selection wins)
- ✅ Result aggregation with vote counts and percentages
- ✅ Close surveys manually
- ❌ Multi-choice questions (future scope)
- ❌ Text/open-ended questions (future scope)
- ❌ Third-party survey integration

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Directory Structure

```
workspace/surveys/
├── survey-001.json    # Survey file
├── survey-002.json    # Another survey
└── ...
```

## Operations

All scripts are located in `skills/survey/` and run via `npx tsx`. Input via environment variables.

### 1. Create Survey

**Usage**: `/survey create`

Create a new survey by running the create script, then send interactive cards for each question.

```bash
SURVEY_ID="survey-$(date +%s)" \
SURVEY_TITLE="餐厅评价调查" \
SURVEY_DESCRIPTION="请对最近团建餐厅进行评价" \
SURVEY_ANONYMOUS="false" \
SURVEY_TARGETS='["ou_user1", "ou_user2", "ou_user3"]' \
SURVEY_QUESTIONS='[
  {"text": "口味评分", "options": ["⭐ 很好吃", "👌 还不错", "😐 一般", "👎 不好吃"]},
  {"text": "环境评分", "options": ["⭐ 非常好", "👌 还不错", "😐 一般", "👎 不好"]},
  {"text": "推荐指数", "options": ["强烈推荐", "可以推荐", "不推荐"]}
]' \
SURVEY_DEADLINE="2026-05-01T10:00:00Z" \
SURVEY_CHAT_ID="oc_xxx" \
npx tsx skills/survey/create.ts
```

After creating the survey, **send interactive cards** for each question to the target chat:

```
send_interactive({
  question: "Q1: 口味评分",
  options: [
    { text: "⭐ 很好吃", value: "survey-survey-001-q0-o0", type: "primary" },
    { text: "👌 还不错", value: "survey-survey-001-q0-o1", type: "default" },
    { text: "😐 一般", value: "survey-survey-001-q0-o2", type: "default" },
    { text: "👎 不好吃", value: "survey-survey-001-q0-o3", type: "danger" }
  ],
  title: "📋 餐厅评价调查 (1/3)",
  context: "匿名调查 | 截止: 2026-05-01",
  chatId: "oc_xxx",
  actionPrompts: {
    "survey-survey-001-q0-o0": "[Survey Response] survey-001 Q0 O0",
    "survey-survey-001-q0-o1": "[Survey Response] survey-001 Q0 O1",
    "survey-survey-001-q0-o2": "[Survey Response] survey-001 Q0 O2",
    "survey-survey-001-q0-o3": "[Survey Response] survey-001 Q0 O3"
  }
})
```

**Action prompt convention**: `"[Survey Response] {surveyId} Q{questionIndex} O{optionIndex}"`

When the agent receives a `[Survey Response]` prompt, it should record the response (see step 2).

### 2. Record Response

**Trigger**: When the agent receives a `[Survey Response] {surveyId} Q{qi} O{oi}` message from a button click.

Extract `surveyId`, question index, and option index, then run:

```bash
SURVEY_ID="survey-001" \
RESPONDER="{sender_open_id}" \
QUESTION_INDEX="0" \
OPTION_INDEX="2" \
npx tsx skills/survey/record-response.ts
```

After recording, acknowledge to the user briefly (e.g., "✅ 已记录") and check if all questions are answered. If all questions answered, send a confirmation card.

### 3. View Results

**Usage**: `/survey results {id}`

```bash
SURVEY_ID="survey-001" npx tsx skills/survey/results.ts
```

Display results as a readable summary card:

```
📊 调查结果: 餐厅评价调查

**Q1: 口味评分** (3 票)
- ⭐ 很好吃: ████████ 2 (67%)
- 👌 还不错: ████ 1 (33%)
- 😐 一般: 0 (0%)
- 👎 不好吃: 0 (0%)

**Q2: 环境评分** (2 票)
...
```

For **anonymous** surveys, do NOT list individual responder names. For non-anonymous surveys, you may show who responded.

### 4. List Surveys

**Usage**: `/survey list [--status open|closed|expired]`

```bash
# List all surveys
npx tsx skills/survey/list.ts

# Filter by status
SURVEY_STATUS="open" npx tsx skills/survey/list.ts
```

Display in table format:

```
📋 Surveys

| ID | Title | Status | Questions | Responses | Deadline |
|----|-------|--------|-----------|-----------|----------|
| survey-001 | 餐厅评价 | 🟢 Open | 3 | 2/5 | 05-01 |
| survey-002 | 满意度 | 🔴 Closed | 2 | 5/5 | 04-28 |
```

### 5. Close Survey

**Usage**: `/survey close {id}`

```bash
SURVEY_ID="survey-001" npx tsx skills/survey/close.ts
```

After closing, send a notification to the chat with final results.

## Survey File Format

```json
{
  "id": "survey-001",
  "status": "open",
  "title": "餐厅评价调查",
  "description": "请对最近团建餐厅进行评价",
  "anonymous": false,
  "targets": ["ou_user1", "ou_user2", "ou_user3"],
  "questions": [
    {
      "index": 0,
      "text": "口味评分",
      "type": "single_choice",
      "options": ["⭐ 很好吃", "👌 还不错", "😐 一般", "👎 不好吃"]
    },
    {
      "index": 1,
      "text": "环境评分",
      "type": "single_choice",
      "options": ["⭐ 非常好", "👌 还不错", "😐 一般", "👎 不好"]
    }
  ],
  "deadline": "2026-05-01T10:00:00Z",
  "createdAt": "2026-04-24T10:00:00Z",
  "chatId": "oc_xxx",
  "responses": {
    "ou_user1:0": {
      "responder": "ou_user1",
      "questionIndex": 0,
      "optionIndex": 0,
      "respondedAt": "2026-04-24T11:30:00Z"
    },
    "ou_user1:1": {
      "responder": "ou_user1",
      "questionIndex": 1,
      "optionIndex": 0,
      "respondedAt": "2026-04-24T11:30:05Z"
    }
  }
}
```

## Lifecycle

```
┌──────────────┐
│     open     │ ← Created
│  接受响应    │
└──────┬───────┘
       │
       ├── Manual close ──→ ┌──────────┐
       │                    │  closed  │
       │                    │  已关闭   │
       │                    └──────────┘
       │
       └── Deadline passed → ┌──────────┐
                            │  expired │
                            │  已过期   │
                            └──────────┘
```

## Complete Workflow Example

### Agent creates a survey

1. User requests: "帮我发起一个关于团建餐厅的调查"
2. Agent collects requirements: title, questions, targets, deadline, anonymous flag
3. Agent runs `create.ts` to create the survey file
4. Agent sends interactive cards for each question using `send_interactive`
5. Agent confirms creation with a summary card

### Users respond

6. User clicks a button on the interactive card
7. Agent receives `[Survey Response]` action prompt
8. Agent parses survey ID, question index, option index from the prompt
9. Agent runs `record-response.ts` to record the response
10. Agent sends brief acknowledgment

### Results

11. User requests: "查看调查结果"
12. Agent runs `results.ts` and formats results as a card
13. Agent sends the results card using `send_card`

## Validation Rules

| Field | Rule |
|-------|------|
| Survey ID | `^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$` |
| Title | Required, max 128 chars |
| Description | Max 1024 chars |
| Questions | 1-10 questions, each with 2-6 options |
| Option text | Required, max 64 chars |
| Targets | 1-50 open IDs (`ou_xxxxx` format) |
| Deadline | UTC Z-suffix ISO 8601, must be in the future |
| Anonymous | Boolean, default false |

## DO NOT

- ❌ Create surveys without questions or targets
- ❌ Send survey cards to users not in the target list
- ❌ Reveal responder identities for anonymous surveys
- ❌ Modify survey questions after creation
- ❌ Delete survey files manually
- ❌ Use non-UTC timestamps
- ❌ Allow more than 10 questions per survey
