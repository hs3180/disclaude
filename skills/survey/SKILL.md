---
name: survey
description: Survey/Polling skill - create and distribute surveys, collect responses, and generate summary reports. Use when user says keywords like "调查", "投票", "问卷", "survey", "poll", "收集反馈".
allowed-tools: [send_user_feedback, Bash, Read, Write, Glob]
---

# Survey / Polling Skill

Create, distribute, and manage lightweight surveys and polls via Feishu interactive cards.

## When to Use This Skill

**Use this skill for:**
- Creating polls or surveys to collect feedback from team members
- Rating/evaluation surveys (e.g., restaurant review, event satisfaction)
- Team decision voting
- Quick single-question polls

**Keywords that trigger this skill**: "调查", "投票", "问卷", "survey", "poll", "收集反馈", "投票", "满意度", "评价"

## Core Principle

**Use prompt-based orchestration with JSON file persistence.**

The agent manages survey lifecycle through structured JSON files and Feishu interactive cards. No dedicated backend needed — the agent itself is the survey engine.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Data Storage

All survey data is stored in `workspace/data/surveys/` as JSON files.

### Survey File Structure

Each survey is stored as `{surveyId}.json`:

```json
{
  "id": "survey_1714646400000",
  "title": "Team Lunch Restaurant Rating",
  "description": "Please rate last Friday's team lunch",
  "createdBy": "ou_xxx",
  "createdAt": "2026-05-02T10:00:00Z",
  "chatId": "oc_xxx",
  "status": "active",
  "deadline": "2026-05-05T10:00:00Z",
  "anonymous": false,
  "questions": [
    {
      "id": "q1",
      "type": "single_choice",
      "text": "How would you rate the food quality?",
      "options": ["Excellent", "Good", "Average", "Poor"],
      "responses": {}
    },
    {
      "id": "q2",
      "type": "single_choice",
      "text": "How would you rate the environment?",
      "options": ["Excellent", "Good", "Average", "Poor"],
      "responses": {}
    },
    {
      "id": "q3",
      "type": "text",
      "text": "Any other comments?",
      "responses": {}
    }
  ]
}
```

### Response Storage

Responses are stored in each question's `responses` object:

```json
{
  "responses": {
    "ou_user1": "Excellent",
    "ou_user2": "Good"
  }
}
```

For text questions, the value is the user's text response.

---

## Workflow

### Step 1: Parse Survey Request

Understand the user's survey requirements from their message:

1. **Title**: What is the survey about?
2. **Questions**: What questions to ask?
3. **Target**: Which chat/group to send to?
4. **Options**: Anonymous? Deadline? Single vs multi-choice?

**Example user requests:**
- "帮我发起一个投票：下次团建去哪里？选项：A.爬山 B.桌游 C.密室逃脱"
- "创建一个调查问卷，收集对昨天活动的满意度，发到 oc_xxx 群"
- "发起投票：这个方案选 A 还是 B？"

### Step 2: Create Survey File

Generate a unique survey ID and create the JSON file:

```bash
# Generate survey ID
SURVEY_ID="survey_$(date +%s)"

# Ensure directory exists
mkdir -p workspace/data/surveys

# Create survey JSON
cat > "workspace/data/surveys/${SURVEY_ID}.json" << 'EOF'
{
  "id": "survey_PLACEHOLDER",
  "title": "...",
  "description": "...",
  "createdBy": "SENDER_OPEN_ID",
  "createdAt": "CURRENT_ISO_TIME",
  "chatId": "TARGET_CHAT_ID",
  "status": "active",
  "deadline": null,
  "anonymous": false,
  "questions": [...]
}
EOF
```

### Step 3: Send Survey Cards

For **each question**, send an interactive card to the target chat.

#### Single-Choice Question Card

Use `send_interactive_message` with each option as a button:

```
send_interactive_message({
  title: "📊 {survey_title} ({question_number}/{total_questions})",
  question: "{question_text}",
  options: [
    { text: "{option_1}", value: "survey:{surveyId}:q1:{option_1}", type: "default" },
    { text: "{option_2}", value: "survey:{surveyId}:q1:{option_2}", type: "default" },
    ...
  ],
  chatId: "{target_chatId}",
  actionPrompts: {
    "survey:{surveyId}:q1:{option_1}": "[投票] 用户在调查「{survey_title}」中为问题「{question_text}」选择了「{option_1}」",
    "survey:{surveyId}:q1:{option_2}": "[投票] 用户在调查「{survey_title}」中为问题「{question_text}」选择了「{option_2}」",
    ...
  }
})
```

#### Text Input Question

For open-ended questions, send a text card with instructions:

```
send_user_feedback({
  chatId: "{target_chatId}",
  message: "📊 **{survey_title}** ({question_number}/{total_questions})\n\n**{question_text}**\n\n请直接回复你的答案，格式：\n`/survey {surveyId} q3 你的回答`"
})
```

### Step 4: Record Responses

When a user responds (via button click or text), record the response:

1. **Parse the response**: Extract `surveyId`, `questionId`, and `answer` from the action prompt
2. **Read the survey file**:
   ```bash
   cat "workspace/data/surveys/{surveyId}.json"
   ```
3. **Update the response** using `jq` or Node.js:
   ```bash
   # Using Node.js to update JSON
   node -e '
   const fs = require("fs");
   const data = JSON.parse(fs.readFileSync("workspace/data/surveys/{surveyId}.json", "utf-8"));
   const q = data.questions.find(q => q.id === "{questionId}");
   if (q) {
     q.responses["{userOpenId}"] = "{answer}";
     fs.writeFileSync("workspace/data/surveys/{surveyId}.json", JSON.stringify(data, null, 2));
   }
   '
   ```
4. **Send confirmation** to the user:
   ```
   send_user_feedback({
     chatId: "{chatId}",
     message: "✅ 已记录你对「{question_text}」的回答"
   })
   ```

**Important**: If `anonymous` is true, use a hash of the user's open ID instead of the actual ID.

### Step 5: Generate Summary Report

When the user asks for results (e.g., "查看调查结果", "投票统计"), generate a report:

1. **Read the survey file**
2. **Calculate statistics** for each question
3. **Send a results card**

#### Results Card Format

Use `send_user_feedback` or `send_card` to display results:

```markdown
📊 **{survey_title}** — 调查结果

📊 参与人数: {respondent_count}/{total_invited}

---

**Q1: {question_text}**
| 选项 | 票数 | 占比 | 分布 |
|------|------|------|------|
| {option_1} | {count} | {percentage}% | {bar} |
| {option_2} | {count} | {percentage}% | {bar} |
...

**Q2: {question_text}**
| 选项 | 票数 | 占比 | 分布 |
|------|------|------|------|
...

**Q3: {question_text}** (开放性问题)
- {response_1}
- {response_2}
...

---
截止时间: {deadline}
状态: {status}
```

Use `send_user_feedback` to send the markdown report:

```
send_user_feedback({
  chatId: "{chatId}",
  message: "{formatted_report}"
})
```

---

## Survey Management Commands

### List Active Surveys

When user says "列出调查" or "查看投票":

```bash
ls workspace/data/surveys/*.json 2>/dev/null | while read f; do
  node -e "const d=JSON.parse(require('fs').readFileSync('$f','utf-8')); if(d.status==='active') console.log(d.id + ' | ' + d.title + ' | ' + Object.keys(d.questions[0]?.responses||{}).length + ' responses')"
done
```

### Close Survey

When user says "结束调查" or "关闭投票":

```bash
node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync("workspace/data/surveys/{surveyId}.json", "utf-8"));
data.status = "closed";
fs.writeFileSync("workspace/data/surveys/{surveyId}.json", JSON.stringify(data, null, 2));
'
```

Then send a final results card.

---

## Example Scenarios

### Scenario 1: Quick Poll (Single Question)

**User**: "发起投票：午饭吃什么？选项：食堂、外卖、出去吃"

**Agent actions**:
1. Create survey with 1 single-choice question
2. Send interactive card with 3 buttons
3. Record each click as a vote
4. Report results when asked

**Card sent**:
```
send_interactive_message({
  title: "📊 午饭吃什么？",
  question: "请选择你今天的午餐方案：",
  options: [
    { text: "🍚 食堂", value: "survey:12345:q1:食堂", type: "primary" },
    { text: "📱 外卖", value: "survey:12345:q1:外卖", type: "default" },
    { text: "🚶 出去吃", value: "survey:12345:q1:出去吃", type: "default" }
  ],
  chatId: "oc_xxx",
  actionPrompts: {
    "survey:12345:q1:食堂": "[投票] 用户在调查「午饭吃什么？」中选择了「🍚 食堂」",
    "survey:12345:q1:外卖": "[投票] 用户在调查「午饭吃什么？」中选择了「📱 外卖」",
    "survey:12345:q1:出去吃": "[投票] 用户在调查「午饭吃什么？」中选择了「🚶 出去吃」"
  }
})
```

### Scenario 2: Multi-Question Survey

**User**: "创建调查：团建满意度评价。Q1:活动安排满意度(1-5星)，Q2:餐饮满意度(1-5星)，Q3:建议(开放文本)。发到 oc_xxx 群"

**Agent actions**:
1. Create survey with 3 questions (2 single-choice + 1 text)
2. Send Q1 and Q2 as interactive cards with 5 options each
3. Send Q3 as text instruction
4. Track responses
5. Generate report when requested

### Scenario 3: Team Decision Vote

**User**: "发起投票决定技术方案：A 微服务架构 vs B 单体架构"

**Agent actions**:
1. Create survey with 1 single-choice question, 2 options
2. Send card with 2 prominent buttons
3. Record votes
4. Report winner

---

## Response Handling Rules

### Deduplication
- Each user can only vote once per question
- If a user votes again, **update** their previous response (not add a new one)
- Log the change: "用户 {userId} 更新了回答从「{old}」到「{new}」"

### Anonymous Mode
- When `anonymous` is `true`:
  - Store responses keyed by hash of open ID: `crypto.createHash('sha256').update(openId).digest('hex').substring(0, 8)`
  - Do NOT show individual user responses in reports
  - Only show aggregate statistics

### Deadline Handling
- Before recording a response, check if the deadline has passed
- If deadline has passed, do NOT record and inform user: "⚠️ 该调查已截止"
- If no deadline is set, the survey remains open indefinitely

---

## Action Prompt Format for Button Clicks

The `actionPrompts` must follow this format for the agent to correctly process responses:

```
Key format: "survey:{surveyId}:{questionId}:{optionText}"
Value format: "[投票] 用户在调查「{surveyTitle}」的问题「{questionText}」中选择了「{optionText}」"
```

When the agent receives a message matching `[投票]`, it should:
1. Extract `surveyId`, `questionId`, and `optionText` from the action prompt
2. Find the survey file in `workspace/data/surveys/`
3. Record the response
4. Send confirmation

---

## Quality Guidelines

### Good Surveys:
- Clear, unambiguous questions
- Reasonable number of options (2-7)
- 1-5 questions per survey
- Mobile-friendly option text (short labels)

### Avoid:
- Too many questions (max 10)
- Overly long option text
- Leading or biased questions
- Missing "other" or "N/A" option when appropriate

---

## DO NOT

- Create surveys without clear questions and options
- Send multiple survey cards simultaneously (send sequentially with brief pauses)
- Record responses for closed/expired surveys
- Show individual responses in anonymous surveys
- Delete survey data without user confirmation
- Create surveys in chats where the bot is not a member
