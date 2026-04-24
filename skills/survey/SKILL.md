---
name: survey
description: Survey/polling management - create, distribute, collect responses, and aggregate results. Use when user says keywords like "调查", "投票", "问卷", "survey", "poll", "收集反馈", "发起投票", "创建问卷". Supports single-choice, multiple-choice, and text questions with optional anonymity and deadlines.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Survey / Polling Manager

Create and manage lightweight surveys within the bot. Distribute interactive cards, collect responses, and aggregate results.

## Single Responsibility

- ✅ Create survey files with questions
- ✅ Send survey questions to target users via `send_interactive`
- ✅ Record responses (per-question, per-user)
- ✅ Aggregate and display results
- ✅ Close surveys manually or on deadline
- ❌ DO NOT send messages directly (use MCP tools)
- ❌ DO NOT create groups (use chat skill if needed)

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

## Operations

All scripts accept input via **environment variables** and are located in `skills/survey/`. Scripts include built-in validation, file locking, and atomic writes.

### 1. Create Survey

**Usage**: `/survey create`

```bash
SURVEY_ID="survey-restaurant-001" \
SURVEY_TITLE="餐厅评价调查" \
SURVEY_DESCRIPTION="请对上周聚餐的餐厅进行评价" \
SURVEY_DEADLINE="2026-04-30T10:00:00Z" \
SURVEY_TARGET_USERS='["ou_user1", "ou_user2", "ou_user3"]' \
SURVEY_QUESTIONS='[
  {"id": "q1", "type": "single_choice", "text": "口味评分", "options": ["1分", "2分", "3分", "4分", "5分"], "required": true},
  {"id": "q2", "type": "single_choice", "text": "环境评分", "options": ["1分", "2分", "3分", "4分", "5分"], "required": true},
  {"id": "q3", "type": "multiple_choice", "text": "喜欢的菜品（多选）", "options": ["红烧肉", "宫保鸡丁", "鱼香肉丝", "麻婆豆腐"], "required": false},
  {"id": "q4", "type": "text", "text": "其他建议", "required": false}
]' \
SURVEY_ANONYMOUS="false" \
SURVEY_CREATED_BY="ou_creator" \
npx tsx skills/survey/create.ts
```

**Validation** (built into script):
- `SURVEY_ID` must match `^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$`
- `SURVEY_DEADLINE` must be UTC Z-suffix ISO 8601
- `SURVEY_TARGET_USERS` must be non-empty JSON array of `ou_xxxxx` open IDs
- `SURVEY_QUESTIONS` must be non-empty JSON array with valid question objects
- Each question needs: `id` (q0, q1...), `type` (single_choice/multiple_choice/text), `text`
- Choice questions need `options` array (min 2, max 10)

### 2. Distribute Survey

After creating the survey, send each question as an interactive card to the target users.

For **single-choice** questions:
```bash
# Use send_interactive MCP tool to send a card with options as buttons
# For each target user, send:
{
  "question": "Q1: 口味评分",
  "options": [
    {"text": "1分", "value": "survey-resp:survey-restaurant-001:ou_user1:q1:1分"},
    {"text": "2分", "value": "survey-resp:survey-restaurant-001:ou_user1:q1:2分"},
    ...
  ],
  "title": "餐厅评价调查",
  "chatId": "<target_user_chat_or_group_chat>",
  "actionPrompts": {
    "survey-resp:survey-restaurant-001:ou_user1:q1:1分": "[调查回复] 用户 ou_user1 对调查 survey-restaurant-001 的问题 q1 选择了: 1分",
    ...
  }
}
```

For **text** questions, include the question as a prompt and instruct the user to type their answer.

### 3. Record Response

When a user responds (via button click or text message), record their answer:

```bash
SURVEY_ID="survey-restaurant-001" \
SURVEY_RESPONDENT="ou_user1" \
SURVEY_ANSWERS='{"q1": "4分", "q2": "5分", "q3": ["红烧肉", "宫保鸡丁"], "q4": "味道不错，下次还来"}' \
npx tsx skills/survey/respond.ts
```

**Note**: For single-user surveys where you send all questions at once, collect all answers first then record in one call. For multi-question interactive flows, you can record partial answers by only including the answered questions.

**Validation**:
- Respondent must be in `targetUsers` list
- Each user can only respond once
- Required questions must be answered
- Answers must match valid options for choice questions
- Survey must be `open` and before deadline

### 4. View Results

**Usage**: `/survey results {id}`

```bash
SURVEY_ID="survey-restaurant-001" npx tsx skills/survey/results.ts
```

Output is a JSON object with aggregated results per question. Display in readable format:

```
📊 调查结果: 餐厅评价调查
> **状态**: ✅ Open | **截止**: 2026-04-30
> **回复率**: 2/3 (67%)

### Q1: 口味评分
| 选项 | 票数 | 占比 |
|------|------|------|
| 4分  | 1    | 50%  |
| 5分  | 1    | 50%  |

### Q2: 环境评分
| 选项 | 票数 | 占比 |
|------|------|------|
| 3分  | 1    | 50%  |
| 4分  | 1    | 50%  |

### Q3: 喜欢的菜品（多选）
| 选项 | 票数 |
|------|------|
| 红烧肉 | 2 |
| 宫保鸡丁 | 1 |

### Q4: 其他建议
- "味道不错，下次还来"
- "希望能增加素菜选项"

⏳ 未回复: ou_user3
```

### 5. Query Survey Status

**Usage**: `/survey query {id}`

```bash
SURVEY_ID="survey-restaurant-001" npx tsx skills/survey/query.ts
```

### 6. Close Survey

**Usage**: `/survey close {id}`

```bash
SURVEY_ID="survey-restaurant-001" npx tsx skills/survey/close.ts
```

## Survey File Format

Each survey is a single JSON file in `workspace/surveys/`:

```json
{
  "id": "survey-restaurant-001",
  "title": "餐厅评价调查",
  "description": "请对上周聚餐的餐厅进行评价",
  "status": "open",
  "anonymous": false,
  "deadline": "2026-04-30T10:00:00Z",
  "targetUsers": ["ou_user1", "ou_user2"],
  "questions": [
    {"id": "q1", "type": "single_choice", "text": "口味评分", "options": ["1分", "2分", "3分", "4分", "5分"], "required": true},
    {"id": "q2", "type": "text", "text": "其他建议", "required": false}
  ],
  "responses": {
    "ou_user1": {
      "answeredAt": "2026-04-25T10:00:00Z",
      "answers": {"q1": "4分", "q2": "味道不错"}
    }
  },
  "createdAt": "2026-04-25T08:00:00Z",
  "createdBy": "ou_creator"
}
```

## Survey Directory

```
workspace/surveys/
├── survey-restaurant-001.json
├── survey-team-vote-002.json
└── survey-feedback-003.json
```

## Typical Workflow

1. User requests a survey (e.g., "帮我发起一个餐厅评价调查")
2. **Create** the survey file with all questions
3. **Distribute** by sending `send_interactive` cards to each target user's chat
4. **Collect** responses as users click buttons or reply
5. **Record** each response via the respond script
6. **Display results** when requested or when all users have responded
7. **Close** the survey manually or after deadline

## DO NOT

- ❌ Send messages directly (use MCP tools like send_interactive)
- ❌ Create groups for surveys (use existing chat or chat skill)
- ❌ Delete survey files manually
- ❌ Record responses for users not in the target list
- ❌ Allow multiple responses from the same user
