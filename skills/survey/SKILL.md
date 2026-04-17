---
name: survey
description: Survey/Poll creation and management - create surveys with single-choice, multiple-choice, and text questions, collect responses from target users, and generate aggregated results. Use when user says keywords like "调查", "投票", "问卷", "survey", "poll", "收集反馈", "发起投票", "/survey create", "/survey results", "/survey close".
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Survey / Poll Manager

Create and manage lightweight surveys/polls to collect feedback from target users via interactive Feishu cards.

## Single Responsibility

- ✅ Create survey files (active status)
- ✅ Record user responses
- ✅ Aggregate and display results
- ✅ Close surveys
- ❌ DO NOT send interactive cards directly (agent handles card sending via MCP tools)
- ❌ DO NOT manage Feishu groups or members

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Survey File Format

Each survey is a JSON file in `workspace/surveys/`:

```json
{
  "id": "restaurant-review",
  "title": "餐厅评价调查",
  "description": "请对上周聚餐的餐厅进行评价",
  "status": "active",
  "createdAt": "2026-04-17T10:00:00Z",
  "closedAt": null,
  "deadline": "2026-04-20T10:00:00Z",
  "anonymous": false,
  "targetUsers": ["ou_user1", "ou_user2"],
  "questions": [
    {
      "id": "q1",
      "type": "single_choice",
      "text": "口味评分",
      "options": ["⭐ 1星", "⭐⭐ 2星", "⭐⭐⭐ 3星", "⭐⭐⭐⭐ 4星", "⭐⭐⭐⭐⭐ 5星"],
      "required": true
    },
    {
      "id": "q2",
      "type": "multiple_choice",
      "text": "喜欢的菜品（多选）",
      "options": ["宫保鸡丁", "水煮鱼", "麻婆豆腐", "回锅肉", "其他"],
      "required": false
    },
    {
      "id": "q3",
      "type": "text",
      "text": "其他建议",
      "required": false
    }
  ],
  "responses": {}
}
```

### Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique survey identifier (used as filename: `{id}.json`) |
| `title` | Yes | Survey title (max 128 chars) |
| `description` | No | Survey description (max 1024 chars) |
| `status` | Yes | `active` → `closed` |
| `createdAt` | Yes | ISO 8601 timestamp |
| `closedAt` | No | ISO 8601 timestamp (set when closed) |
| `deadline` | No | ISO 8601 Z-suffix auto-close deadline |
| `anonymous` | Yes | Whether responses are anonymous (boolean) |
| `targetUsers` | Yes | Array of target user open IDs (ou_xxxxx) |
| `questions` | Yes | Array of question objects (max 20) |
| `responses` | Yes | Object keyed by user ID or anonymized key |

### Question Types

| Type | Description | `options` | Answer format |
|------|-------------|-----------|---------------|
| `single_choice` | Pick one option | Required (≥2) | `string` |
| `multiple_choice` | Pick multiple options | Required (≥2) | `string[]` |
| `text` | Free-form text | Not used | `string` |

## Operations

All scripts are located in `skills/survey/`. Scripts use environment variables for input and include built-in validation, path traversal protection, and file locking.

### 1. Create Survey

**Usage**: `/survey create` or agent invocation

```bash
SURVEY_ID="restaurant-review" \
SURVEY_TITLE="餐厅评价调查" \
SURVEY_DESCRIPTION="请对上周聚餐的餐厅进行评价" \
SURVEY_DEADLINE="2026-04-20T10:00:00Z" \
SURVEY_ANONYMOUS="false" \
SURVEY_TARGET_USERS='["ou_user1", "ou_user2"]' \
SURVEY_QUESTIONS='[
  {"id": "q1", "type": "single_choice", "text": "口味评分", "options": ["⭐ 1星", "⭐⭐ 2星", "⭐⭐⭐ 3星", "⭐⭐⭐⭐ 4星", "⭐⭐⭐⭐⭐ 5星"], "required": true},
  {"id": "q2", "type": "text", "text": "其他建议", "required": false}
]' \
npx tsx skills/survey/create.ts
```

### 2. Record Response

```bash
SURVEY_ID="restaurant-review" \
SURVEY_USER="ou_user1" \
SURVEY_ANSWERS='{"q1": "⭐⭐⭐⭐ 4星", "q2": "味道很好，服务也不错"}' \
npx tsx skills/survey/respond.ts
```

### 3. View Results

```bash
SURVEY_ID="restaurant-review" \
npx tsx skills/survey/results.ts
```

Output example:
```json
{
  "surveyId": "restaurant-review",
  "title": "餐厅评价调查",
  "status": "active",
  "totalRespondents": 5,
  "targetCount": 10,
  "completionRate": "50.0%",
  "questions": [
    {
      "questionId": "q1",
      "questionText": "口味评分",
      "questionType": "single_choice",
      "totalResponses": 5,
      "results": [
        {"option": "⭐⭐⭐⭐⭐ 5星", "count": 3, "percentage": "60.0%"},
        {"option": "⭐⭐⭐⭐ 4星", "count": 2, "percentage": "40.0%"}
      ]
    }
  ]
}
```

### 4. Close Survey

```bash
SURVEY_ID="restaurant-review" \
npx tsx skills/survey/close.ts
```

## Agent Workflow: Sending Survey Cards

When a user requests a survey, the agent should:

### Step 1: Parse the request

Understand the survey intent from user's message:
- Title and description
- Questions and their types
- Target users (if specified)
- Deadline (if specified)
- Anonymous flag

### Step 2: Create survey file

Generate a unique survey ID and create the survey file:

```bash
SURVEY_ID="survey-$(date +%Y%m%d%H%M%S)" \
SURVEY_TITLE="..." \
SURVEY_TARGET_USERS='[...]' \
SURVEY_QUESTIONS='[...]' \
npx tsx skills/survey/create.ts
```

### Step 3: Send interactive cards

For each **choice-type** question, send an interactive card using `send_interactive`:

```
send_interactive({
  chatId: "{chatId}",
  title: "📊 {survey_title} — Q{i}/{total}",
  question: "{question_text}",
  options: [
    { text: "Option A", value: "survey-{id}-q{i}-Option A", type: "primary" },
    { text: "Option B", value: "survey-{id}-q{i}-Option B" },
    ...
  ],
  actionPrompts: {
    "survey-{id}-q{i}-Option A": "[投票] 用户在调查「{survey_title}」问题 {i} 选择了 Option A",
    "survey-{id}-q{i}-Option B": "[投票] 用户在调查「{survey_title}」问题 {i} 选择了 Option B",
    ...
  }
})
```

For **text questions**, send a message asking users to reply in a specific format:

```
send_card({
  chatId: "{chatId}",
  card: {
    config: { wide_screen_mode: true },
    header: { title: { content: "📊 {survey_title} — Q{i}/{total}（文本题）", tag: "plain_text" }, template: "blue" },
    elements: [
      { tag: "markdown", content: "{question_text}" },
      { tag: "markdown", content: "💬 请直接回复此消息来作答" }
    ]
  }
})
```

### Step 4: Record responses

When a user interacts with a survey card (button click or text reply), parse the response and record it:

```bash
SURVEY_ID="..." \
SURVEY_USER="ou_xxx" \
SURVEY_ANSWERS='{"q1": "...", "q2": "..."}' \
npx tsx skills/survey/respond.ts
```

### Step 5: Show results

When requested, run results script and format as a card:

```bash
SURVEY_ID="..." npx tsx skills/survey/results.ts
```

Then display results using `send_card`:

```
send_card({
  chatId: "{chatId}",
  card: {
    config: { wide_screen_mode: true },
    header: { title: { content: "📊 调查结果: {title}", tag: "plain_text" }, template: "green" },
    elements: [
      { tag: "markdown", content: "📈 **回收率**: {completionRate} ({totalRespondents}/{targetCount})" },
      { tag: "hr" },
      // For each question:
      { tag: "markdown", content: "**Q{i}. {questionText}** ({totalResponses} 人回答)" },
      // For choice questions: bar chart
      { tag: "markdown", content: "- Option A: ████████ 3 (60.0%)" },
      // For text questions: list answers
      { tag: "markdown", content: "> \"Answer 1\"" },
      { tag: "hr" },
    ]
  }
})
```

## Lifecycle

```
┌─────────────┐         ┌──────────────┐
│   active    │────────>│    closed    │
│  收集中     │ close   │   已结束     │
└─────────────┘         └──────────────┘
```

| Status | Meaning | Trigger | Who Sets |
|--------|---------|---------|----------|
| `active` | Accepting responses | Survey created | **create.ts** |
| `closed` | No more responses | Manual close or deadline passed | **close.ts** |

## Survey Directory

```
workspace/surveys/
├── restaurant-review.json       # Active survey
├── team-vote-20260417.json      # Another survey
└── ...
```

## DO NOT

- ❌ Send interactive cards directly from scripts (agent handles via MCP tools)
- ❌ Modify survey files created by other processes
- ❌ Create surveys without at least one question
- ❌ Delete survey files manually
- ❌ Allow responses after survey is closed
- ❌ Allow duplicate responses from the same user (unless anonymous)
- ❌ Use YAML format for survey files (always JSON)

## Error Handling

| Scenario | Action |
|----------|--------|
| Survey file not found | Report "Survey {id} not found" |
| Survey already closed | Report "Survey {id} is closed" |
| Deadline passed | Report "Survey deadline has passed" |
| Duplicate response | Report "User has already responded" |
| Invalid survey ID | Report "Invalid survey ID" and reject |
| Invalid question type | Report error with valid types |
| Invalid answer option | Report error with valid options |
| Missing required answer | Report which question is required |
