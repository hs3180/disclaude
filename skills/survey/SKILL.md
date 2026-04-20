---
name: survey
description: Lightweight survey/poll skill - create and manage in-chat surveys to collect feedback from specified users. Use when user says keywords like "投票", "调查", "问卷", "收集反馈", "survey", "poll", "vote", "/survey create", "/survey results".
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Survey / Poll Manager

Create and manage lightweight surveys to collect feedback from specified users via interactive Feishu cards.

## Single Responsibility

- ✅ Create surveys with configurable questions (single choice, multiple choice, text)
- ✅ Send survey cards to target users via `send_interactive`
- ✅ Collect and aggregate responses
- ✅ Display results with statistics
- ✅ Manage survey lifecycle (draft → active → closed)
- ❌ DO NOT send survey to users not in targetUsers list
- ❌ DO NOT modify responses after submission
- ❌ DO NOT create Feishu groups (use chat skill for that)

## Invocation Modes

### Mode 1: Slash Command

```
/survey create       — Create a new survey (interactive)
/survey results {id} — View survey results
/survey list         — List all surveys
```

### Mode 2: Agent Invocation

Called by other agents/schedules that need to collect user feedback.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Survey File Format

Each survey is a JSON file in `workspace/surveys/`:

```json
{
  "id": "lunch-poll-2026",
  "title": "团队午餐偏好调查",
  "description": "请选择你偏好的午餐类型",
  "status": "draft",
  "anonymous": false,
  "questions": [
    {
      "id": "q1",
      "text": "你最喜欢的午餐类型？",
      "type": "single_choice",
      "options": ["中餐", "日料", "西餐", "东南亚菜"]
    },
    {
      "id": "q2",
      "text": "有什么特别想吃的吗？",
      "type": "text"
    }
  ],
  "createdAt": "2026-04-21T10:00:00Z",
  "deadline": "2026-04-21T18:00:00Z",
  "targetUsers": ["ou_user1", "ou_user2"],
  "responses": []
}
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier (used as filename: `{id}.json`) |
| `title` | Yes | Survey title shown in card header |
| `description` | No | Description shown above questions |
| `status` | Yes | `draft` → `active` → `closed` |
| `anonymous` | Yes | Whether responses are anonymous |
| `questions` | Yes | Non-empty array of question objects |
| `questions[].id` | Yes | Unique question ID (e.g. "q1") |
| `questions[].text` | Yes | Question text |
| `questions[].type` | Yes | `single_choice`, `multiple_choice`, or `text` |
| `questions[].options` | Conditional | Required for choice types, ignored for text |
| `createdAt` | Yes | ISO 8601 timestamp |
| `deadline` | No | ISO 8601 deadline |
| `targetUsers` | Yes | Non-empty array of `ou_xxx` open IDs |
| `responses` | Yes | Array of user responses (initially empty) |

## Operations

### 1. Create Survey

**Usage**: `/survey create` or agent invocation

Gather the following information from the user:
1. Survey title
2. Questions (type + options for choice questions)
3. Target users (open_id list)
4. Optional: deadline, anonymous mode

Then create the survey file:

```bash
SURVEY_ID="lunch-poll-2026" \
SURVEY_TITLE="团队午餐偏好调查" \
SURVEY_DESC="请选择你偏好的午餐类型" \
SURVEY_ANONYMOUS="false" \
SURVEY_DEADLINE="2026-04-21T18:00:00Z" \
SURVEY_TARGETS='["ou_user1", "ou_user2"]' \
SURVEY_QUESTIONS='[{"id":"q1","text":"你最喜欢的午餐类型？","type":"single_choice","options":["中餐","日料","西餐","东南亚菜"]}]' \
npx tsx skills/survey/create.ts
```

### 2. Activate and Send Survey

After creating, activate the survey and send cards to each target user:

```bash
# Activate
SURVEY_ID="lunch-poll-2026" SURVEY_ACTION="activate" npx tsx skills/survey/activate.ts
```

Then use `send_interactive` MCP tool to send a card to each target user. For **single_choice** questions, construct buttons from options:

```
send_interactive({
  chatId: "{chatId}",
  title: "{survey_title}",
  question: "{question_text}",
  context: "📋 Survey: {survey_title}\n⏰ Deadline: {deadline}",
  options: [
    { text: "选项A", value: "survey:{surveyId}:q1:选项A", type: "primary" },
    { text: "选项B", value: "survey:{surveyId}:q1:选项B", type: "default" },
  ],
  actionPrompts: {
    "survey:{surveyId}:q1:选项A": "[投票] 用户选择了 选项A",
    "survey:{surveyId}:q1:选项B": "[投票] 用户选择了 选项B",
  }
})
```

**Important**: The `actionPrompts` value format is:
- Key: `survey:{surveyId}:{questionId}:{optionValue}`
- Value: `[投票] 用户选择了 {optionText}`

When the user clicks a button, the agent receives the prompt and should:
1. Parse the action value to extract surveyId, questionId, and selected option
2. Record the response using the submit script

### 3. Record Response

When a user clicks a survey button (via actionPrompt callback):

```bash
SURVEY_ID="lunch-poll-2026" \
SURVEY_RESPONDER="ou_user1" \
SURVEY_ANSWERS='[{"questionId":"q1","value":"中餐"}]' \
npx tsx skills/survey/submit.ts
```

### 4. View Results

**Usage**: `/survey results {id}`

```bash
SURVEY_ID="lunch-poll-2026" npx tsx skills/survey/results.ts
```

Display results in a readable format:

```
📊 Survey Results: 团队午餐偏好调查
   Status: active | Response Rate: 67% (2/3)

❓ 你最喜欢的午餐类型？ (single_choice, 2 response(s))
   中餐: ██████████ 1 (50%)
   日料: ██████████ 1 (50%)
   西餐: 0 (0%)
   东南亚菜: 0 (0%)
```

### 5. Close Survey

```bash
SURVEY_ID="lunch-poll-2026" SURVEY_ACTION="close" npx tsx skills/survey/activate.ts
```

## Lifecycle

```
┌──────────┐   activate    ┌──────────┐   close / deadline   ┌──────────┐
│  draft   │ ───────────> │  active  │ ──────────────────> │  closed  │
│ 创建完成 │              │ 收集响应  │                      │ 结果汇总  │
└──────────┘              └──────────┘                      └──────────┘
```

## Survey Directory

```
workspace/surveys/
├── lunch-poll-2026.json     # Lunch preference survey
├── sprint-retro-42.json     # Sprint retrospective
└── feature-priority.json    # Feature priority voting
```

## Multi-Question Handling

For surveys with multiple questions, send each question as a separate card. The `actionPrompts` value encodes the question ID, so responses are correctly attributed.

Order of sending: send questions sequentially to avoid confusion.

## Error Handling

| Scenario | Action |
|----------|--------|
| Survey not found | Report "Survey {id} not found" |
| Survey not active | Report "Survey is {status}, expected active" |
| User not in targetUsers | Report "User is not a target of this survey" |
| Deadline passed | Report "Survey deadline has passed" |
| Invalid survey ID | Report "Invalid survey ID format" |
| Duplicate survey ID | Report "Survey {id} already exists" |

## DO NOT

- ❌ Send survey cards to users not in targetUsers
- ❌ Allow responses after deadline
- ❌ Modify existing responses (overwrites are allowed for same user)
- ❌ Delete survey files manually
- ❌ Use YAML format (always JSON)
