---
name: survey
description: Create and manage interactive surveys and polls to collect feedback from users. Use when user asks for "投票", "调查", "问卷", "survey", "poll", "收集反馈", "发起投票", "满意度调查", "评选".
argument-hint: "[调查主题或描述]"
allowed-tools: Read, Write, Glob, Bash
---

# Survey / Poll Manager

Create and manage lightweight interactive surveys and polls to collect structured feedback from group members.

## When to Use This Skill

**Use this skill for:**
- Creating quick polls (single question, multiple options)
- Building multi-question surveys (rating, choice, text)
- Collecting satisfaction ratings (e.g., event feedback, meeting review)
- Running team decision votes
- Gathering structured feedback on specific topics

**Keywords that trigger this skill**: "投票", "调查", "问卷", "survey", "poll", "收集反馈", "发起投票", "满意度调查", "评选", "打分", "rating"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Survey Types

### Type 1: Quick Poll (快速投票)

Single-question poll with predefined options. Best for simple decisions.

**Usage**: `/survey 午餐吃什么？` or `/survey 投票：下一个Sprint优先级`

**Flow**:
1. Generate a question with 2-6 options
2. Send as interactive card to the group
3. Each member votes by clicking a button
4. Poll creator can end the poll by saying "结束投票" or "查看结果"
5. Generate and display results summary

### Type 2: Rating Survey (评分调查)

Collect ratings on multiple dimensions using a 1-5 star scale.

**Usage**: `/survey 对本次会议满意度评分` or `/survey 评价这间餐厅`

**Flow**:
1. Generate rating dimensions (3-5 items)
2. Ask one dimension at a time via interactive card (1-5 buttons)
3. After all dimensions, show a summary card
4. Optional: ask for open-ended feedback

### Type 3: Multi-Question Survey (多题问卷)

Sequential questions with mixed types (choice + text).

**Usage**: `/survey 收集团队对远程办公的看法` or `/survey 活动反馈问卷`

**Flow**:
1. Generate 3-7 questions based on the topic
2. Present questions one at a time
3. Choice questions → interactive card with buttons
4. Text questions → plain text prompt, wait for user reply
5. After all questions, generate summary

---

## State Management

### Directory Structure

```
workspace/surveys/
├── active/              # Active surveys
│   └── {surveyId}.json  # Survey definition + responses
└── completed/           # Completed surveys
    └── {surveyId}.json  # Final results
```

### Survey Data Schema

```json
{
  "id": "poll_20260407_abc123",
  "type": "poll|rating|survey",
  "title": "午餐吃什么？",
  "chatId": "oc_xxx",
  "creator": "ou_xxx",
  "anonymous": false,
  "status": "active|completed",
  "createdAt": "2026-04-07T10:00:00Z",
  "questions": [
    {
      "id": "q1",
      "text": "今天午餐吃什么？",
      "type": "single_choice|rating|text",
      "options": ["火锅", "烧烤", "日料", "西餐", "快餐"],
      "required": true
    }
  ],
  "responses": [
    {
      "userId": "ou_xxx",
      "userName": "User A",
      "answers": {
        "q1": "火锅"
      },
      "timestamp": "2026-04-07T10:05:00Z"
    }
  ]
}
```

### Operations

**Create survey**:
```bash
mkdir -p workspace/surveys/active
# Write survey JSON to workspace/surveys/active/{surveyId}.json
```

**Update response**:
```bash
# Read existing survey, append response, write back
```

**Complete survey**:
```bash
mv workspace/surveys/active/{surveyId}.json workspace/surveys/completed/
```

**List active surveys**:
```bash
ls workspace/surveys/active/
```

---

## Implementation Workflow

### Step 1: Parse Request

Determine survey type from user input:

| Input Pattern | Type | Example |
|---------------|------|---------|
| Contains "投票"/"vote" | Quick Poll | "投票选出最佳方案" |
| Contains "评分"/"满意度"/"rating" | Rating Survey | "会议满意度评分" |
| Contains "调查"/"问卷"/"反馈" | Multi-Question | "用户体验调查" |
| Open-ended description | Auto-detect | "收集大家对新办公室的看法" |

### Step 2: Generate Survey

Based on the type, generate appropriate questions:

**Quick Poll**: 1 question + 2-6 options
**Rating Survey**: 3-5 dimensions, each with 1-5 scale
**Multi-Question Survey**: 3-7 questions with mixed types

**Important**: If the user provides specific questions/options in their request, use them exactly. Only generate questions when the user provides a general topic.

### Step 3: Present Questions

#### For Choice Questions (single_choice)

Send an interactive card:

```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "📊 投票：午餐吃什么？", "tag": "plain_text"}, "template": "blue"},
    "elements": [
      {"tag": "markdown", "content": "请选择你今天的午餐偏好：\n\n📊 当前 3 人已投票"},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "🍲 火锅", "tag": "plain_text"}, "value": "vote_火锅", "type": "default"},
        {"tag": "button", "text": {"content": "🥩 烧烤", "tag": "plain_text"}, "value": "vote_烧烤", "type": "default"},
        {"tag": "button", "text": {"content": "🍣 日料", "tag": "plain_text"}, "value": "vote_日料", "type": "default"},
        {"tag": "button", "text": {"content": "🍝 西餐", "tag": "plain_text"}, "value": "vote_西餐", "type": "default"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "<chat_id>",
  "actionPrompts": {
    "vote_火锅": "[投票] 用户选择了 火锅",
    "vote_烧烤": "[投票] 用户选择了 烧烤",
    "vote_日料": "[投票] 用户选择了 日料",
    "vote_西餐": "[投票] 用户选择了 西餐"
  }
}
```

#### For Rating Questions

Send a rating card:

```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "⭐ 会议满意度评分", "tag": "plain_text"}, "template": "turquoise"},
    "elements": [
      {"tag": "markdown", "content": "**会议内容质量**\n请为本次会议的内容质量打分："},
      {"tag": "hr"},
      {"tag": "action", "actions": [
        {"tag": "button", "text": {"content": "1 ⭐", "tag": "plain_text"}, "value": "rating_1", "type": "danger"},
        {"tag": "button", "text": {"content": "2 ⭐⭐", "tag": "plain_text"}, "value": "rating_2", "type": "default"},
        {"tag": "button", "text": {"content": "3 ⭐⭐⭐", "tag": "plain_text"}, "value": "rating_3", "type": "default"},
        {"tag": "button", "text": {"content": "4 ⭐⭐⭐⭐", "tag": "plain_text"}, "value": "rating_4", "type": "default"},
        {"tag": "button", "text": {"content": "5 ⭐⭐⭐⭐⭐", "tag": "plain_text"}, "value": "rating_5", "type": "primary"}
      ]}
    ]
  },
  "format": "card",
  "chatId": "<chat_id>",
  "actionPrompts": {
    "rating_1": "[评分] 用户打分 1 分",
    "rating_2": "[评分] 用户打分 2 分",
    "rating_3": "[评分] 用户打分 3 分",
    "rating_4": "[评分] 用户打分 4 分",
    "rating_5": "[评分] 用户打分 5 分"
  }
}
```

#### For Text Questions

Send a plain text prompt and wait for the user's natural language reply:
```
📝 **开放题 3/5**: 你认为本次活动最大的亮点是什么？

请直接回复你的想法。
```

### Step 4: Process Responses

When a user clicks a button or replies with text:

1. **Identify the survey**: Match the response to an active survey in the current chat
2. **Record the answer**: Update the survey JSON with the user's response
3. **Prevent duplicate votes**: For polls, check if the user has already voted (overwrite if changed)
4. **Send next question**: For multi-question surveys, proceed to the next question
5. **Acknowledge**: Send a brief confirmation (e.g., "✅ 已记录你的投票")

### Step 5: Generate Results

When the survey creator says "结束投票", "查看结果", "结束调查", or all expected respondents have answered:

1. Read the survey data from `workspace/surveys/active/{surveyId}.json`
2. Calculate statistics:
   - For polls: option counts and percentages
   - For ratings: average, min, max per dimension
   - For surveys: response counts and answer summaries
3. Send a results card to the chat
4. Move survey to `workspace/surveys/completed/`

**Poll Results Card Example**:
```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "📊 投票结果：午餐吃什么？", "tag": "plain_text"}, "template": "green"},
    "elements": [
      {"tag": "markdown", "content": "**共 8 人参与投票**\n\n| 选项 | 票数 | 占比 |\n|------|------|------|\n| 🍲 火锅 | 3 | 37.5% |\n| 🥩 烧烤 | 2 | 25.0% |\n| 🍣 日料 | 2 | 25.0% |\n| 🍝 西餐 | 1 | 12.5% |\n\n🏆 **获胜选项: 火锅**"}
    ]
  },
  "format": "card",
  "chatId": "<chat_id>"
}
```

**Rating Results Card Example**:
```json
{
  "content": {
    "config": {"wide_screen_mode": true},
    "header": {"title": {"content": "⭐ 满意度评分结果", "tag": "plain_text"}, "template": "turquoise"},
    "elements": [
      {"tag": "markdown", "content": "**共 5 人参与评分**\n\n| 维度 | 平均分 |\n|------|--------|\n| 会议内容质量 | 4.2 ⭐ |\n| 时间安排 | 3.8 ⭐ |\n| 讨论效率 | 4.0 ⭐ |\n| 整体满意度 | 4.4 ⭐ |\n\n**综合评分: 4.1 / 5.0**"}
    ]
  },
  "format": "card",
  "chatId": "<chat_id>"
}
```

---

## Survey Lifecycle Commands

| Command | Action |
|---------|--------|
| `/survey [topic]` | Create new survey |
| "结束投票" / "查看结果" | End poll and show results |
| "下一题" / "跳过" | Skip current question (survey mode) |
| "取消调查" | Cancel active survey |

---

## Edge Cases

### Duplicate Votes
- For polls: Allow users to change their vote (overwrite previous answer)
- For surveys: Allow users to re-answer if they reply again

### Survey in Group Chat
- Multiple users can participate
- Each user's response is tracked by their Sender Open ID
- Anonymous mode: Record responses without user names in results display

### Survey Timeout
- No automatic timeout in this implementation
- Survey remains active until creator ends it

---

## Examples

### Example 1: Quick Poll

**User**: `/survey 投票选下周五的团建活动`

**Agent**:
1. Generates poll: "下周五团建活动投票"
2. Options: ["密室逃脱", "桌游", "聚餐", "户外徒步", "KTV"]
3. Sends interactive card to group
4. Waits for votes...

**User**: *(clicks "密室逃脱" button)*

**Agent**: Records vote, updates count. "✅ 已记录投票！当前 3/8 人已投票。"

**User**: "结束投票"

**Agent**: Generates results card showing vote counts and winner.

### Example 2: Rating Survey

**User**: `/survey 对本次技术分享会评分`

**Agent**:
1. Generates 4 rating dimensions: 内容质量, 演讲表达, 实用性, 整体满意度
2. Sends first rating card (1-5 buttons)
3. User clicks rating → records → sends next dimension
4. After all dimensions → sends results summary

### Example 3: Multi-Question Survey

**User**: `/survey 收集对远程办公政策的反馈`

**Agent**:
1. Generates 5 questions:
   - Q1 (choice): 你更偏好哪种工作模式？ [全远程 / 混合 / 全坐班]
   - Q2 (choice): 你觉得每周到办公室几天合适？ [1天 / 2天 / 3天 / 4天 / 5天]
   - Q3 (rating): 你对当前远程办公工具的满意度？ [1-5]
   - Q4 (text): 远程办公最大的挑战是什么？
   - Q5 (text): 你有什么改进建议？
2. Presents questions sequentially
3. Generates summary after completion

---

## Checklist

- [ ] Parsed user request and determined survey type
- [ ] Generated appropriate questions (or used user-provided questions)
- [ ] Created survey JSON in `workspace/surveys/active/`
- [ ] Sent first question via interactive card or text
- [ ] Recorded user responses correctly
- [ ] Handled duplicate votes appropriately
- [ ] Generated results summary when requested
- [ ] Moved completed survey to `workspace/surveys/completed/`

---

## DO NOT

- Create surveys with more than 10 questions (keep it lightweight)
- Send all questions at once (present sequentially for better UX)
- Reveal individual voter choices in anonymous mode
- Auto-close polls without creator's explicit request
- Create surveys in private chats without confirming with the user
- Ignore existing active surveys in the same chat (warn user before creating a new one)
