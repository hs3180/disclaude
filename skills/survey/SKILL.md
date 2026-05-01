---
name: survey
description: Create and manage lightweight polls/surveys to collect feedback from users in Feishu groups. Use when user says keywords like "调查", "投票", "问卷", "survey", "poll", "收集反馈", "发起投票", "feedback collection".
allowed-tools: send_text, send_interactive, send_card, Read, Write, Bash, Glob
disable-model-invocation: true
argument-hint: [question or sub-command]
---

# Survey / Polling Skill

Create and manage lightweight polls and surveys within Feishu groups. Collect user feedback via interactive cards and generate result summaries.

## When to Use

**Trigger keywords**: "调查", "投票", "问卷", "survey", "poll", "收集反馈", "发起投票"

**Use cases**:
- Quick single-question polls (e.g., "Which restaurant for lunch?")
- Multi-option voting (e.g., feature prioritization)
- Simple feedback collection (e.g., event satisfaction)
- Team decision making

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Sub-commands

| Command | Description |
|---------|-------------|
| `/survey <question>` | Create a new poll (auto-extract options or ask user) |
| `/survey results <survey-id>` | Show results for a specific survey |
| `/survey list` | List all active surveys |
| `/survey close <survey-id>` | Close a survey and show final results |

---

## Step 1: Parse User Request

Determine what the user wants to do:

### Creating a new poll

**If user provides a clear question with options** (e.g., "今天中午吃什么？A.面条 B.米饭 C.汉堡"):
1. Extract the question text
2. Extract the option labels
3. Proceed to Step 2

**If user provides only a question** (e.g., "大家对这次活动满意吗？"):
1. Ask the user what options they want via `send_interactive` or `send_text`
2. Suggest common options based on the question type:

| Question Type | Suggested Options |
|---------------|-------------------|
| Satisfaction | 非常满意, 满意, 一般, 不满意 |
| Yes/No | ✅ 同意, ❌ 反对, 🤷 中立 |
| Rating | ⭐⭐⭐⭐⭐, ⭐⭐⭐⭐, ⭐⭐⭐, ⭐⭐, ⭐ |
| Choice | User-provided options |

**If user invokes `/survey list`**: Go to Step 5
**If user invokes `/survey results <id>`**: Go to Step 4
**If user invokes `/survey close <id>`**: Go to Step 6

---

## Step 2: Create Survey

### 2.1 Generate Survey ID

```bash
echo "survey-$(date +%Y%m%d%H%M%S)"
```

### 2.2 Initialize Survey Data

Create the survey state file at `workspace/data/surveys/{surveyId}.json`:

Use the **Write** tool to create:
```json
{
  "id": "{surveyId}",
  "question": "{the question text}",
  "options": [
    { "label": "Option A", "value": "opt_a" },
    { "label": "Option B", "value": "opt_b" }
  ],
  "createdBy": "{senderOpenId}",
  "chatId": "{chatId}",
  "createdAt": "{ISO timestamp}",
  "status": "active",
  "responses": {},
  "anonymous": false,
  "maxParticipants": null
}
```

### 2.3 Send Interactive Poll Card

Use `send_interactive` to send the poll card to the target chat:

```
send_interactive({
  question: "{question text}",
  options: [
    { text: "Option A", value: "vote_{surveyId}_opt_a", type: "default" },
    { text: "Option B", value: "vote_{surveyId}_opt_b", type: "default" },
    ...
  ],
  title: "📊 投票",
  context: "发起人: {sender name or mention}",
  chatId: "{chatId}",
  actionPrompts: {
    "vote_{surveyId}_opt_a": "[投票操作] 用户投票选择了「Option A」(调查ID: {surveyId})",
    "vote_{surveyId}_opt_b": "[投票操作] 用户投票选择了「Option B」(调查ID: {surveyId})",
    ...
  }
})
```

**Important**:
- Each option value MUST include the surveyId so the Agent can identify which survey the response belongs to
- The actionPrompt MUST include the surveyId and option label for the Agent to process correctly
- Use `{surveyId}` as a unique identifier in option values and prompts

### 2.4 Confirm to Creator

Send a confirmation message:
```
✅ 投票已创建！

📊 问题: {question}
📋 选项: {list of options}
🆔 调查ID: {surveyId}

查看结果: /survey results {surveyId}
关闭投票: /survey close {surveyId}
```

---

## Step 3: Handle Vote Response

When the Agent receives a vote callback message like:
> `[投票操作] 用户投票选择了「Option A」(调查ID: survey-20260501120000)`

### 3.1 Parse the callback

Extract from the message:
- **Option label**: "Option A" (from 「」)
- **Survey ID**: "survey-20260501120000" (from parentheses)

### 3.2 Update survey data

1. Use **Read** to load `workspace/data/surveys/{surveyId}.json`
2. Parse the JSON
3. Find the option matching the label
4. Record the response:

```json
{
  "responses": {
    "{userOpenId}": {
      "option": "opt_a",
      "label": "Option A",
      "timestamp": "{ISO timestamp}"
    }
  }
}
```

**Rules**:
- Each user can only vote once (overwrite previous vote for same user)
- Use the sender's Open ID from the context as the key
- If `anonymous: true`, use a hash of the Open ID instead

5. Use **Write** to save the updated JSON

### 3.3 Acknowledge the vote

Send a brief confirmation to the user via `send_text`:
```
✅ 已收到您的投票！
```

Or if changing a previous vote:
```
✅ 已更新您的投票！
```

### 3.4 Update poll card (optional)

After each vote, you can optionally update the poll results by sending a summary card to the original chat. Use `send_card`:

```json
{
  "card": {
    "config": { "wide_screen_mode": true },
    "header": {
      "title": { "content": "📊 投票进度", "tag": "plain_text" },
      "template": "blue"
    },
    "elements": [
      { "tag": "markdown", "content": "**问题**: {question}" },
      { "tag": "hr" },
      { "tag": "markdown", "content": "Option A: ████████ 4票 (40%)" },
      { "tag": "markdown", "content": "Option B: ██████ 3票 (30%)" },
      { "tag": "markdown", "content": "Option C: ████ 2票 (20%)" },
      { "tag": "markdown", "content": "Option D: ██ 1票 (10%)" },
      { "tag": "hr" },
      { "tag": "note", "elements": [{ "tag": "plain_text", "content": "共 10 人参与投票" }] }
    ]
  },
  "chatId": "{chatId}"
}
```

**Bar chart format**: Use Unicode block characters to visualize results:
- `█` for filled portions
- `░` for unfilled portions
- Calculate percentage: `(votes / total) * 100`
- Bar width: 10-15 characters

---

## Step 4: Show Results

When user invokes `/survey results {surveyId}`:

### 4.1 Load survey data

Use **Read** to load `workspace/data/surveys/{surveyId}.json`

### 4.2 Generate results card

Build a results summary card using `send_card`:

```json
{
  "card": {
    "config": { "wide_screen_mode": true },
    "header": {
      "title": { "content": "📊 投票结果", "tag": "plain_text" },
      "template": "green"
    },
    "elements": [
      { "tag": "markdown", "content": "**问题**: {question}" },
      { "tag": "markdown", "content": "**状态**: {'🟢 进行中' or '🔴 已关闭'}" },
      { "tag": "hr" },
      {
        "tag": "column_set",
        "columns": [
          { "width": 3, "elements": [{ "tag": "markdown", "content": "**选项**" }] },
          { "width": 2, "elements": [{ "tag": "markdown", "content": "**票数**" }] },
          { "width": 3, "elements": [{ "tag": "markdown", "content": "**比例**" }] }
        ]
      },
      { "tag": "markdown", "content": "Option A: ████████ 4票 (40%)" },
      { "tag": "markdown", "content": "Option B: ██████ 3票 (30%)" },
      ...
      { "tag": "hr" },
      { "tag": "note", "elements": [{ "tag": "plain_text", "content": "共 {total} 人参与 | 创建于 {createdAt}" }] }
    ]
  },
  "chatId": "{chatId}"
}
```

### 4.3 Highlight winner

If the survey is closed or has a clear winner, highlight it:
- Use `🏆` emoji for the winning option
- Show margin of victory if applicable

---

## Step 5: List Active Surveys

When user invokes `/survey list`:

### 5.1 Find all survey files

Use **Glob** to find `workspace/data/surveys/survey-*.json`

### 5.2 Load and display summary

For each survey, show a brief summary:
```
📊 活跃调查列表:

1. 📋 survey-20260501120000
   问题: 今天中午吃什么？
   状态: 🟢 进行中 | 已投票: 5人

2. 📋 survey-20260501110000
   问题: 下次团建去哪里？
   状态: 🔴 已关闭 | 已投票: 12人
```

---

## Step 6: Close Survey

When user invokes `/survey close {surveyId}`:

### 6.1 Verify ownership

Only the survey creator can close it. Check that the sender's Open ID matches `createdBy`.

### 6.2 Update status

Load the survey, set `status: "closed"`, and save.

### 6.3 Show final results

Generate the results card (same as Step 4) with a "Final Results" header:

```json
{
  "header": {
    "title": { "content": "📊 投票最终结果", "tag": "plain_text" },
    "template": "violet"
  }
}
```

Add a winner highlight:
```
🏆 获胜选项: Option A (4票, 40%)
```

---

## Data Management

### Storage Location

All survey data is stored in `workspace/data/surveys/`:
```
workspace/data/surveys/
├── survey-20260501120000.json
├── survey-20260501110000.json
└── ...
```

### Survey JSON Schema

```json
{
  "id": "string - unique survey identifier",
  "question": "string - the poll question",
  "options": [
    { "label": "string - display text", "value": "string - internal value" }
  ],
  "createdBy": "string - open_id of creator",
  "chatId": "string - target chat",
  "createdAt": "string - ISO 8601 timestamp",
  "closedAt": "string | null - ISO 8601 timestamp when closed",
  "status": "active | closed",
  "responses": {
    "open_id": {
      "option": "string - option value",
      "label": "string - option display text",
      "timestamp": "string - ISO 8601"
    }
  },
  "anonymous": "boolean - whether votes are anonymous",
  "maxParticipants": "number | null - max allowed participants"
}
```

---

## Important Rules

### Voting Rules
- Each user can vote **once** (subsequent votes overwrite the previous one)
- Only the creator can close the survey
- Closed surveys do not accept new votes (Agent should inform the user)

### Data Safety
- Never expose Open IDs in visible output unless `anonymous: false`
- Sanitize all user-provided content before displaying in cards
- Keep survey JSON files clean and well-structured

### Error Handling
- If survey file not found: "❌ 调查不存在，请检查ID是否正确"
- If survey already closed: "❌ 该调查已关闭，不再接受投票"
- If not creator trying to close: "❌ 只有发起人可以关闭此调查"

---

## DO NOT

- ❌ Create surveys without a clear question
- ❌ Allow unlimited options (max 6 for readability)
- ❌ Expose voter identities when `anonymous: true`
- ❌ Delete survey data without user confirmation
- ❌ Send multiple poll cards for the same survey
- ❌ Accept votes after the survey is closed

---

## Example Flow

### User: "发起一个投票：今天团建去哪里？A. 密室逃脱 B. KTV C. 桌游 D. 烧烤"

**Agent creates:**
1. Generates survey ID: `survey-20260502140000`
2. Saves state to `workspace/data/surveys/survey-20260502140000.json`
3. Sends interactive card with 4 options
4. Confirms to user

### User clicks "KTV"

**Agent receives**: `[投票操作] 用户投票选择了「KTV」(调查ID: survey-20260502140000)`

**Agent updates** survey JSON and acknowledges.

### User: "/survey results survey-20260502140000"

**Agent generates results card** with bar charts and vote counts.
