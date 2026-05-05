---
name: survey
description: Survey and polling skill - create polls, collect votes, and display results. Use when user says "投票", "调查", "问卷", "发起投票", "创建投票", "收集反馈", "survey", "poll", "vote".
allowed-tools: [send_user_feedback, Read, Write, Bash]
---

# Survey / Poll Skill

Create, manage, and aggregate interactive surveys and polls in Feishu chats.

## When to Use This Skill

**Use this skill for:**
- Creating polls or surveys to collect feedback from group members
- Voting on decisions (e.g., restaurant choice, meeting time)
- Rating or evaluating something (e.g., event satisfaction)
- Any scenario requiring structured feedback collection

**Keywords that trigger this skill**: "投票", "调查", "问卷", "发起投票", "创建投票", "收集反馈", "survey", "poll", "vote"

## Core Principle

**Use prompt-based interaction, NOT complex program modules.**

The LLM analyzes the request, creates interactive cards, and manages survey state through file-based storage.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Survey Types

| Type | Description | Example |
|------|-------------|---------|
| **Single Choice** | User selects one option | "Vote for lunch: A, B, C" |
| **Rating** | Rate on a scale (1-5) | "Rate today's meeting: ⭐ to ⭐⭐⭐⭐⭐" |
| **Yes/No** | Simple binary vote | "Should we adopt framework X?" |
| **Multi-round** | Survey with multiple questions | "Team satisfaction survey" |

---

## Workflow

### Step 1: Parse Request

Identify the survey intent from the user's message:

**Required information:**
- **Question/Topic**: What to ask
- **Options**: Available choices (if not provided, generate reasonable defaults)

**Optional information:**
- **Target chat**: Where to send (default: current chat)
- **Deadline**: When to close (default: 24 hours)
- **Anonymous**: Whether votes are anonymous (default: yes)
- **Max selections**: For multi-choice (default: 1 = single choice)

**Example parsing:**
```
User: "发起投票：午饭吃什么？选项：火锅、日料、西餐"
→ Question: 午饭吃什么？
→ Options: [火锅, 日料, 西餐]
→ Type: Single Choice
```

```
User: "调查大家对这次活动的满意度"
→ Question: 活动满意度调查
→ Options: [⭐ 很不满意, ⭐⭐ 不太满意, ⭐⭐⭐ 一般, ⭐⭐⭐⭐ 满意, ⭐⭐⭐⭐⭐ 非常满意]
→ Type: Rating
```

### Step 2: Create Survey Data

Generate a unique survey ID and save survey metadata to a local file:

```bash
# Create survey data directory
mkdir -p workspace/data/surveys
```

Write survey data to `workspace/data/surveys/{surveyId}.json`:

```json
{
  "surveyId": "survey_20260506_143000",
  "chatId": "{current_chatId}",
  "creatorOpenId": "{sender_open_id}",
  "question": "午饭吃什么？",
  "type": "single_choice",
  "options": [
    { "label": "🍲 火锅", "value": "hotpot" },
    { "label": "🍣 日料", "value": "japanese" },
    { "label": "🥩 西餐", "value": "western" }
  ],
  "anonymous": true,
  "createdAt": "2026-05-06T14:30:00Z",
  "deadline": "2026-05-07T14:30:00Z",
  "votes": {},
  "status": "active"
}
```

### Step 3: Send Interactive Poll Card

Send an interactive card with voting buttons using `send_user_feedback`:

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "📊 投票"},
    "template": "indigo"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "**{question}**\n发起人: {creator_name}\n截止时间: {deadline}"
    },
    {"tag": "hr"},
    {
      "tag": "action",
      "actions": [
        {"tag": "button", "text": {"tag": "plain_text", "content": "{option_1_label}"}, "value": "{option_1_value}", "type": "primary"},
        {"tag": "button", "text": {"tag": "plain_text", "content": "{option_2_label}"}, "value": "{option_2_value}", "type": "default"},
        {"tag": "button", "text": {"tag": "plain_text", "content": "{option_3_label}"}, "value": "{option_3_value}", "type": "default"}
      ]
    },
    {"tag": "hr"},
    {
      "tag": "markdown",
      "content": "💬 点击按钮参与投票 | 匿名投票"
    }
  ]
}
```

**IMPORTANT**: Include `actionPrompts` in the card response to handle button clicks:

```json
{
  "format": "card",
  "chatId": "{chatId}",
  "actionPrompts": {
    "{option_1_value}": "[投票操作] 用户投票给: {option_1_label} (surveyId: {surveyId})",
    "{option_2_value}": "[投票操作] 用户投票给: {option_2_label} (surveyId: {surveyId})",
    "{option_3_value}": "[投票操作] 用户投票给: {option_3_label} (surveyId: {surveyId})"
  }
}
```

### Step 4: Handle Vote Responses

When a user clicks a button, you receive a message like:
```
[投票操作] 用户投票给: 🍲 火锅 (surveyId: survey_20260506_143000)
```

**Process the vote:**

1. **Read** the survey data file: `workspace/data/surveys/{surveyId}.json`
2. **Record** the vote:
   - If anonymous: just increment the count
   - If not anonymous: record who voted
3. **Handle duplicate votes**: Allow user to change their vote (latest wins)
4. **Write** the updated data back to the file
5. **Send** a confirmation message to the user

**Vote recording logic:**

```json
{
  "votes": {
    "hotpot": {
      "count": 3,
      "voters": ["ou_xxx", "ou_yyy", "ou_zzz"]
    },
    "japanese": {
      "count": 2,
      "voters": ["ou_aaa", "ou_bbb"]
    }
  }
}
```

**For anonymous surveys**, do not include voter IDs in the results.

### Step 5: Display Results

When the creator asks for results (or when the deadline passes), aggregate and display:

**Read** the survey data file and send a results card:

```json
{
  "config": {"wide_screen_mode": true},
  "header": {
    "title": {"tag": "plain_text", "content": "📊 投票结果"},
    "template": "green"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "**{question}**\n总投票数: {total_votes}"
    },
    {"tag": "hr"},
    {
      "tag": "markdown",
      "content": "🍲 火锅: ████████ 3票 (50%)\n🍣 日料: █████ 2票 (33%)\n🥩 西餐: ██ 1票 (17%)"
    },
    {"tag": "hr"},
    {
      "tag": "markdown",
      "content": "🏆 **火锅** 获胜！"
    }
  ]
}
```

**Visual bar chart**: Use Unicode block characters to represent proportions:
- `█` for filled
- `░` for empty
- 10 characters max width

### Step 6: Close Survey

When requested or deadline passes:

1. Update survey status to `closed`
2. Send final results to the chat
3. Announce the winner (if applicable)

---

## Commands

The skill supports these implicit commands through natural language:

| User Message | Action |
|-------------|--------|
| "发起投票 / 创建投票 / 发起调查" | Create a new survey |
| "查看投票结果 / 投票结果" | Show current results |
| "关闭投票 / 结束投票" | Close the survey and show final results |
| "列出所有投票" | List all active surveys in current chat |

---

## Data Storage

All survey data is stored in `workspace/data/surveys/`:

```
workspace/data/surveys/
├── survey_20260506_143000.json    # Active survey
├── survey_20260506_150000.json    # Another survey
└── ...
```

**File naming**: `survey_{YYYYMMDD}_{HHMMSS}.json`

### Listing Surveys

To find all surveys for a chat:
```bash
grep -l '"chatId": "{chatId}"' workspace/data/surveys/*.json
```

To find active surveys:
```bash
grep -l '"status": "active"' workspace/data/surveys/*.json
```

---

## Example Scenarios

### Scenario 1: Simple Vote

**User**: "投票：午饭吃什么？火锅、日料、西餐"

**Agent actions**:
1. Create survey data file
2. Send interactive card with 3 buttons
3. Wait for votes

**User clicks "🍲 火锅"**:
1. Record vote in survey data
2. Reply: "✅ 投票已记录"

**User**: "查看结果"
1. Read survey data
2. Send results card with bar chart

### Scenario 2: Rating Survey

**User**: "大家对今天的团建满意吗？"

**Agent actions**:
1. Create rating survey with 5 options
2. Send interactive card

### Scenario 3: Yes/No Decision

**User**: "要不要用 TypeScript 重写这个项目？"

**Agent actions**:
1. Create yes/no survey
2. Send card with ✅ / ❌ buttons

---

## Survey Data Lifecycle

```
Create → Active (accepting votes) → Closed (show results)
```

**Auto-close**: Check deadline when reading survey data. If expired, mark as closed and show results.

---

## DO NOT

- ❌ Create surveys without clear questions
- ❌ Allow multiple votes from the same user in single-choice mode (replace with latest)
- ❌ Store sensitive user data outside workspace/data/surveys/
- ❌ Send results without being asked (unless deadline notification)
- ❌ Create more than one survey card for the same question
- ❌ Forget to include actionPrompts for button handling

## Best Practices

- ✅ Generate concise, clear survey questions
- ✅ Use emoji for option labels to make them visually distinct
- ✅ Include deadline information in the card
- ✅ Show total vote count in results
- ✅ Use proportional bar charts for visual results
- ✅ Announce the winner/consensus clearly
