---
name: survey
description: Survey and polling tool - create polls, collect votes, and generate result reports via Feishu interactive cards. Use when user says keywords like "投票", "调查", "问卷", "收集反馈", "survey", "poll", "vote", "questionnaire", "发起投票".
disable-model-invocation: false
allowed-tools: Read, Write, Bash, Glob, Grep
---

# Survey / Polling Skill

Create and manage lightweight surveys and polls via Feishu interactive cards.

## When to Use

**Keywords that trigger this skill**: "投票", "调查", "问卷", "收集反馈", "survey", "poll", "vote", "questionnaire", "发起投票"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from `**Chat ID:** xxx`)
- **Message ID**: Message ID (from `**Message ID:** xxx`)

## Core Principle

**Use prompt-based orchestration, NOT complex program modules.**

The LLM should directly manage survey lifecycle through interactive cards and workspace files.

---

## Survey Lifecycle

### Phase 1: Survey Creation

When a user requests a survey, gather the following information:

#### Required Parameters
| Parameter | Description | Example |
|-----------|-------------|---------|
| **Title** | Survey title | "午餐满意度调查" |
| **Questions** | One or more questions | See question types below |
| **Target** | Target chat/group | Current chat or specified chatId |

#### Optional Parameters
| Parameter | Default | Description |
|-----------|---------|-------------|
| **Anonymous** | `false` | Hide respondent identities in results |
| **Deadline** | None | Auto-close survey after deadline |
| **MaxResponses** | Unlimited | Maximum number of responses |

#### Question Types

| Type | Description | Example |
|------|-------------|---------|
| **single** | Single choice (one option) | "评分 1-5 星" |
| **multiple** | Multiple choice (N options) | "选择你喜欢的菜品（可多选）" |
| **text** | Open-ended text response | "有什么建议？" |

#### Creation Flow

1. **Parse user intent** from the message or arguments
2. **Validate** minimum requirements (at least 1 question with options for choice types)
3. **Generate a survey ID** using format: `survey_{timestamp}_{random}` (e.g., `survey_20260503_a3f2`)
4. **Create survey state file** at `workspace/data/surveys/{surveyId}.json`
5. **Send interactive cards** to the target chat

### Phase 2: Survey State File

Store survey state in `workspace/data/surveys/{surveyId}.json`:

```json
{
  "id": "survey_20260503_a3f2",
  "title": "午餐满意度调查",
  "createdAt": "2026-05-03T10:00:00Z",
  "status": "active",
  "config": {
    "anonymous": false,
    "deadline": null,
    "maxResponses": null
  },
  "questions": [
    {
      "id": "q1",
      "type": "single",
      "text": "今天午餐你满意吗？",
      "options": ["非常满意", "满意", "一般", "不满意", "非常不满意"]
    }
  ],
  "responses": {},
  "targetChatId": "oc_xxx"
}
```

### Phase 3: Send Survey Cards

For each question, send an interactive card using `send_interactive`:

#### Single-Choice Question

```
send_interactive({
  title: "📊 {survey_title} ({question_number}/{total_questions})",
  question: "{question_text}",
  options: [
    { text: "⭐⭐⭐⭐⭐ 非常满意", value: "q1_5", type: "primary" },
    { text: "⭐⭐⭐⭐ 满意", value: "q1_4", type: "default" },
    { text: "⭐⭐⭐ 一般", value: "q1_3", type: "default" },
    { text: "⭐⭐ 不满意", value: "q1_2", type: "default" },
    { text: "⭐ 非常不满意", value: "q1_1", type: "danger" }
  ],
  chatId: "{target_chatId}",
  actionPrompts: {
    "q1_5": "[投票] 用户对问题q1选择了: 非常满意",
    "q1_4": "[投票] 用户对问题q1选择了: 满意",
    "q1_3": "[投票] 用户对问题q1选择了: 一般",
    "q1_2": "[投票] 用户对问题q1选择了: 不满意",
    "q1_1": "[投票] 用户对问题q1选择了: 非常不满意"
  }
})
```

#### Text Question

For text/open-ended questions, send a regular message explaining how to respond:

```
send_text({
  text: "📝 **{survey_title}** — {question_text}\n\n请直接回复你的答案，格式：`回答 {surveyId} {questionId} 你的答案`",
  chatId: "{target_chatId}"
})
```

### Phase 4: Response Collection

When a user responds (via button click or text reply):

1. **Identify the user** from the sender context
2. **Record the response** in the survey state file
3. **Send confirmation** to the user
4. **Check if survey is complete** (all questions answered or deadline reached)

#### Recording a Response

Read the current survey file, update it, then write it back:

```json
{
  "responses": {
    "ou_user123": {
      "answeredAt": "2026-05-03T10:05:00Z",
      "answers": {
        "q1": "5",
        "q2": "口味很好，但环境一般"
      }
    }
  }
}
```

**Anonymous mode**: Replace `ou_user123` with `anonymous_{hash}` — use a short hash of the openId so responses are still deduplicated but identities are hidden in reports.

### Phase 5: Result Reporting

When the survey creator asks for results, or when a deadline is reached:

1. **Read** the survey state file
2. **Calculate** statistics per question
3. **Send** a result card using `send_card`

#### Result Card Format

```
send_card({
  chatId: "{chatId}",
  card: {
    config: { wide_screen_mode: true },
    header: {
      title: { content: "📊 调查结果: {survey_title}", tag: "plain_text" },
      template: "green"
    },
    elements: [
      { tag: "markdown", content: "共收到 **{total_responses}** 份回复\n" },
      { tag: "hr" },
      {
        tag: "markdown",
        content: "**Q1: {question_text}**\n\n| 选项 | 票数 | 占比 | 分布 |\n|------|------|------|------|\n| ⭐⭐⭐⭐⭐ 非常满意 | 5 | 50% | ████████████ |\n| ⭐⭐⭐⭐ 满意 | 3 | 30% | ███████ |\n| ⭐⭐⭐ 一般 | 2 | 20% | ████ |"
      },
      { tag: "hr" },
      {
        tag: "markdown",
        content: "**Q2: {open_question_text}**\n\n> \"口味很好，但环境一般\"\n> \"希望增加素食选项\""
      }
    ]
  }
})
```

---

## Command Reference

Users can interact with the survey system using these patterns:

| Command | Description |
|---------|-------------|
| `投票/调查/问卷 + {topic}` | Create a new survey |
| `查看结果 {surveyId}` | View survey results |
| `关闭调查 {surveyId}` | Close an active survey |
| `列出调查` | List all surveys |

### Creation Examples

**Simple poll (single question, auto-detect):**

User says: "发起一个投票：今天吃什么？选项：火锅、烧烤、日料、西餐"

→ Create a single-question single-choice poll automatically.

**Multi-question survey:**

User says: "创建一个满意度调查，包括口味、环境、服务三个维度，每个1-5分"

→ Create a 3-question survey with rating scales.

**From arguments:**

```
/survey title=午餐满意度 q1=今天午餐你满意吗？(1-5分) q2=有什么建议？(文本)
```

---

## Survey State Management

### File Location

```
workspace/data/surveys/
├── survey_20260503_a3f2.json   # Active survey
├── survey_20260502_b7d1.json   # Closed survey
└── ...
```

### State Transitions

```
[created] → [active] → [closed]
                ↑          |
                └──────────┘ (reopen)
```

| Status | Description |
|--------|-------------|
| `created` | Survey initialized, cards not yet sent |
| `active` | Cards sent, accepting responses |
| `closed` | No longer accepting responses |

### Cleanup

Surveys closed for more than 7 days can be safely deleted. Always confirm with the user before deleting.

---

## Quick-Start Template

For the most common use case — a simple poll — use this streamlined flow:

1. User says: "发起投票：{question}？选项：{a}、{b}、{c}"
2. Create survey file with 1 single-choice question
3. Send 1 interactive card with the options
4. When user clicks, record response and update file
5. When asked, show results as a bar chart in card format

---

## DO NOT

- ❌ Create surveys without questions
- ❌ Send survey cards to unauthorized chats
- ❌ Expose anonymous respondents' identities
- ❌ Delete survey data without confirmation
- ❌ Block waiting for responses (surveys are asynchronous)
- ❌ Create complex multi-step wizards for simple polls — keep it simple
