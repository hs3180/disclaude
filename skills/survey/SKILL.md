---
name: survey
description: Survey/Poll creation and management - create lightweight surveys with single-choice, multiple-choice, and text questions, distribute to target users via interactive cards, collect responses, and summarize results. Use when user says keywords like "survey", "poll", "投票", "调查", "问卷", "收集反馈", "vote", "create survey".
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Survey Manager

Create and manage lightweight surveys/polls to collect feedback from specified users via interactive Feishu cards.

## Single Responsibility

- ✅ Create survey files (data model)
- ✅ Distribute survey questions as interactive cards via `send_interactive`
- ✅ Record user responses
- ✅ Query survey status and results
- ✅ Summarize and visualize results
- ❌ DO NOT directly message users outside the current chat (use `send_interactive` tool for the current chatId)

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Survey File Format

Each survey is a JSON file in `workspace/surveys/`:

```json
{
  "id": "lunch-2026-04-19",
  "title": "午餐满意度调查",
  "description": "请评价今天的午餐",
  "status": "open",
  "anonymous": false,
  "expiresAt": "2026-04-20T10:00:00Z",
  "createdAt": "2026-04-19T10:00:00Z",
  "targetUsers": ["ou_user1", "ou_user2"],
  "chatId": "oc_xxx",
  "questions": [
    {
      "id": "q1",
      "type": "single_choice",
      "text": "口味评分",
      "options": ["⭐", "⭐⭐", "⭐⭐⭐", "⭐⭐⭐⭐", "⭐⭐⭐⭐⭐"],
      "required": true
    },
    {
      "id": "q2",
      "type": "text",
      "text": "有什么建议？",
      "required": false
    }
  ],
  "responses": {}
}
```

### Question Types

| Type | Description | Interaction |
|------|-------------|-------------|
| `single_choice` | Pick one option | Buttons (one per option) |
| `multiple_choice` | Pick multiple options | Sequential single-choice cards or text-based |
| `text` | Free-form text answer | User types response directly |

## Operations

All scripts accept input via **environment variables** and are located in `skills/survey/`.

### 1. Create Survey

**Usage**: `/survey create` or agent-driven

```bash
SURVEY_ID="lunch-2026-04-19" \
SURVEY_TITLE="午餐满意度调查" \
SURVEY_DESCRIPTION="请评价今天的午餐" \
SURVEY_EXPIRES_AT="2026-04-20T10:00:00Z" \
SURVEY_TARGET_USERS='["ou_user1", "ou_user2"]' \
SURVEY_QUESTIONS='[
  {"id": "q1", "type": "single_choice", "text": "口味评分", "options": ["⭐", "⭐⭐", "⭐⭐⭐", "⭐⭐⭐⭐", "⭐⭐⭐⭐⭐"], "required": true},
  {"id": "q2", "type": "text", "text": "有什么建议？", "required": false}
]' \
SURVEY_CHAT_ID="oc_xxx" \
npx tsx skills/survey/create.ts
```

### 2. Distribute Survey Questions

After creating the survey, send each question as an interactive card using `send_interactive` MCP tool:

For **single_choice** questions, send buttons:

```
send_interactive({
  question: "Q1: 口味评分",
  options: [
    { text: "⭐", value: "q1:⭐", type: "default" },
    { text: "⭐⭐", value: "q1:⭐⭐", type: "default" },
    { text: "⭐⭐⭐", value: "q1:⭐⭐⭐", type: "default" },
    { text: "⭐⭐⭐⭐", value: "q1:⭐⭐⭐⭐", type: "primary" },
    { text: "⭐⭐⭐⭐⭐", value: "q1:⭐⭐⭐⭐⭐", type: "primary" },
  ],
  title: "午餐满意度调查",
  context: "请为本项评分",
  chatId: "{chatId}",
  actionPrompts: {
    "q1:⭐": "[Survey Response] 用户对 survey:lunch-2026-04-19 问题 q1 选择 ⭐",
    "q1:⭐⭐": "[Survey Response] 用户对 survey:lunch-2026-04-19 问题 q1 选择 ⭐⭐",
    "q1:⭐⭐⭐": "[Survey Response] 用户对 survey:lunch-2026-04-19 问题 q1 选择 ⭐⭐⭐",
    "q1:⭐⭐⭐⭐": "[Survey Response] 用户对 survey:lunch-2026-04-19 问题 q1 选择 ⭐⭐⭐⭐",
    "q1:⭐⭐⭐⭐⭐": "[Survey Response] 用户对 survey:lunch-2026-04-19 问题 q1 选择 ⭐⭐⭐⭐⭐"
  }
})
```

For **text** questions, send a prompt card:

```
send_interactive({
  question: "Q2: 有什么建议？",
  options: [
    { text: "📝 回答", value: "q2:answer", type: "primary" }
  ],
  title: "午餐满意度调查",
  context: "请直接回复您的建议",
  chatId: "{chatId}",
  actionPrompts: {
    "q2:answer": "[Survey Response] 用户准备回答 survey:lunch-2026-04-19 问题 q2（文本回答）"
  }
})
```

**When receiving survey responses via actionPrompts callback:**

Parse the action value to extract question ID and answer:
- Format: `{questionId}:{answerValue}` or `{questionId}:answer`
- For text answers: the user will type their response after clicking the button

Then record the response:

```bash
SURVEY_ID="lunch-2026-04-19" \
SURVEY_RESPONDER="ou_xxx" \
SURVEY_ANSWERS='{"q1": "⭐⭐⭐⭐"}' \
npx tsx skills/survey/respond.ts
```

### 3. Query Survey

```bash
SURVEY_ID="lunch-2026-04-19" npx tsx skills/survey/query.ts
```

Display in readable format:

```
📊 Survey: 午餐满意度调查
> **Status**: 🟢 Open
> **Created**: 2026-04-19 10:00
> **Expires**: 2026-04-20 10:00
> **Target Users**: 2
> **Responses**: 1/2
```

### 4. List Surveys

```bash
# List all surveys
npx tsx skills/survey/list.ts

# Filter by status
SURVEY_STATUS="open" npx tsx skills/survey/list.ts
```

### 5. Close Survey

To manually close a survey before expiry, update the status:

```bash
# Read the survey file, update status to "closed", write back
SURVEY_ID="lunch-2026-04-19" npx tsx skills/survey/query.ts | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  data.status = 'closed';
  require('fs').writeFileSync('workspace/surveys/' + data.id + '.json', JSON.stringify(data, null, 2) + '\n');
"
```

### 6. Summarize Results

After collecting responses, generate a summary card:

```
send_card({
  card: {
    config: { wide_screen_mode: true },
    header: {
      title: { content: "📊 Survey Results: 午餐满意度调查", tag: "plain_text" },
      template: "green"
    },
    elements: [
      { tag: "markdown", content: "**Total Responses**: 2/2\n**Period**: 2026-04-19 ~ 2026-04-20" },
      { tag: "hr" },
      { tag: "markdown", content: "**Q1: 口味评分**\n⭐⭐⭐⭐: 1 票 (50%)\n⭐⭐⭐⭐⭐: 1 票 (50%)" },
      { tag: "hr" },
      { tag: "markdown", content: "**Q2: 有什么建议？**\n> 希望有更多素食选项\n> 汤可以再咸一点" }
    ]
  },
  chatId: "{chatId}"
})
```

## Workflow

### Creating and Running a Survey

1. **User requests a survey**: "帮我创建一个关于午餐满意度的调查"
2. **Clarify requirements**: Ask for title, target users, questions, expiry
3. **Create survey file**: Use `create.ts` script
4. **Send question cards**: Use `send_interactive` for each question
5. **Collect responses**: Handle `actionPrompts` callbacks, record via `respond.ts`
6. **Summarize**: When all responses collected or survey expires, generate results card

### Response Handling Flow

```
User clicks button → actionPrompts triggers → Agent receives prompt
→ Parse question ID and answer from action value
→ Record response via respond.ts
→ Send confirmation to user
→ Check if all users have responded → If yes, auto-summarize
```

## Directory

```
workspace/surveys/
├── lunch-2026-04-19.json     # Survey with responses
├── team-vote-2026-04.json    # Another survey
└── ...
```

## DO NOT

- ❌ Create surveys without a valid `expiresAt` (must be UTC Z-suffix)
- ❌ Allow responses after survey expiry
- ❌ Use YAML format (always JSON)
- ❌ Delete survey files manually
- ❌ Send survey cards to chats other than the originating chatId
- ❌ Expose anonymous responders' identities in results

## Error Handling

| Scenario | Action |
|----------|--------|
| Survey not found | Report "Survey '{id}' not found" |
| Survey already closed | Report "Survey '{id}' is closed" |
| Survey expired | Auto-close and report |
| Duplicate response (non-anonymous) | Report "User has already responded" |
| Unknown question ID in response | Report "Unknown question ID" |
| Invalid survey ID (path traversal) | Report "Invalid survey ID" and reject |

## Example: Restaurant Evaluation Survey

### Step 1: User Request

> "帮我创建一个餐厅评价调查，问大家口味和环境怎么样，发给 ou_user1 和 ou_user2"

### Step 2: Create Survey

```bash
SURVEY_ID="restaurant-eval-20260419" \
SURVEY_TITLE="餐厅评价调查" \
SURVEY_DESCRIPTION="请评价最近的聚餐体验" \
SURVEY_EXPIRES_AT="2026-04-21T10:00:00Z" \
SURVEY_TARGET_USERS='["ou_user1", "ou_user2"]' \
SURVEY_QUESTIONS='[
  {"id": "q1", "type": "single_choice", "text": "口味评分", "options": ["很不满意", "不满意", "一般", "满意", "非常满意"], "required": true},
  {"id": "q2", "type": "single_choice", "text": "环境评分", "options": ["很不满意", "不满意", "一般", "满意", "非常满意"], "required": true},
  {"id": "q3", "type": "text", "text": "其他建议", "required": false}
]' \
SURVEY_CHAT_ID="oc_current_chat" \
npx tsx skills/survey/create.ts
```

### Step 3: Send Question Cards

Send interactive cards for q1 and q2 (single_choice), and a prompt card for q3 (text).

### Step 4: Collect & Summarize

When responses come in or survey expires, generate a results summary card.
