---
name: survey
description: Survey and polling skill - create polls, collect votes, and display results. Use when user says "投票", "调查", "问卷", "发起投票", "创建投票", "收集反馈", "survey", "poll", "vote".
allowed-tools: [Read, Write, Bash, Glob, Grep]
---

# Survey / Poll Skill

Create lightweight polls and surveys using interactive cards. Collect votes from group members and display aggregated results.

## When to Use This Skill

**Use this skill for:**
- Creating single-question polls (single-select or multi-select)
- Collecting quick feedback from group members
- Team decision-making via voting
- Rating/satisfaction surveys

**Keywords that trigger this skill**: "投票", "调查", "问卷", "发起投票", "创建投票", "收集反馈", "survey", "poll", "vote", "问卷调查"

**Do NOT use this skill for:**
- Complex multi-page questionnaires (use external survey tools instead)
- Anonymous feedback collection (current MVP limitation)
- Time-limited surveys with automatic deadlines

---

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Workflow

### Step 1: Parse the Survey Request

Extract the following from the user's message:

| Field | Required | Description |
|-------|----------|-------------|
| **title** | Yes | Poll title / question |
| **options** | Yes | List of choices (2-10 options) |
| **multiSelect** | No | Allow multiple selections (default: false) |
| **description** | No | Additional context or description |

**Parsing examples:**

```
User: "发起投票：午饭吃什么？选项：A. 麻辣烫 B. 沙县 C. 黄焖鸡"
→ title: "午饭吃什么？"
→ options: ["麻辣烫", "沙县", "黄焖鸡"]

User: "帮我做一个满意度调查，1-5星"
→ title: "满意度调查"
→ options: ["⭐", "⭐⭐", "⭐⭐⭐", "⭐⭐⭐⭐", "⭐⭐⭐⭐⭐"]

User: "投票：是否同意周五团建？"
→ title: "是否同意周五团建？"
→ options: ["同意", "不同意", "弃权"]
```

If the user doesn't provide enough options, ask for clarification before proceeding.

### Step 2: Create Survey Data File

Create a JSON file to track the survey state:

**File path**: `workspace/surveys/{chatId}/{messageId}.json`

```bash
mkdir -p workspace/surveys/{chatId}
```

**File content**:
```json
{
  "id": "{messageId}",
  "chatId": "{chatId}",
  "title": "Poll title",
  "description": "Optional description",
  "options": [
    { "value": "opt_0", "label": "Option A", "votes": 0 },
    { "value": "opt_1", "label": "Option B", "votes": 0 },
    { "value": "opt_2", "label": "Option C", "votes": 0 }
  ],
  "multiSelect": false,
  "createdAt": "2026-01-01T00:00:00Z",
  "status": "active",
  "totalVotes": 0
}
```

Use the Write tool to create this file.

### Step 3: Send the Poll Card

Use `send_interactive` to create the poll card with clickable options.

**For single-select polls**, use this pattern:

```
send_interactive({
  question: "{title}\n\n{description if any}",
  options: [
    { text: "A. {option_label}", value: "opt_0", type: "default" },
    { text: "B. {option_label}", value: "opt_1", type: "default" },
    ...
  ],
  title: "📊 投票",
  chatId: "{chatId}",
  actionPrompts: {
    "opt_0": "[投票] 用户对「{survey_title}」选择了「{option_0_label}」。请更新投票数据文件 workspace/surveys/{chatId}/{messageId}.json，将 opt_0 的 votes 加 1，totalVotes 加 1，然后回复确认。",
    "opt_1": "[投票] 用户对「{survey_title}」选择了「{option_1_label}」。请更新投票数据文件 workspace/surveys/{chatId}/{messageId}.json，将 opt_1 的 votes 加 1，totalVotes 加 1，然后回复确认。",
    ...
  }
})
```

**Important**:
- Use `type: "primary"` for the most recommended option if applicable
- Keep button text concise (under 20 characters recommended)
- actionPrompts must include the exact survey file path so the agent can find it when handling votes

### Step 4: Handle Vote Responses

When a user clicks a vote button, the agent receives the actionPrompt message. Follow these steps:

1. **Read the survey data file** from the path in the actionPrompt
2. **Increment the vote count** for the selected option
3. **Increment totalVotes**
4. **Save the updated file** using Write tool
5. **Reply with a brief confirmation**, e.g.:
   ```
   ✅ 已记录您的投票！当前共 {totalVotes} 人参与投票。
   ```
6. **Optionally show current standings** (but do NOT reveal individual votes):
   ```
   📊 当前投票情况：
   - A. 麻辣烫: 3 票 (50%)
   - B. 沙县: 2 票 (33%)
   - C. 黄焖鸡: 1 票 (17%)
   ```

### Step 5: Show Results

When a user asks to see results ("查看结果", "投票结果", "当前票数"), or when the poll creator decides to close the poll:

1. **Read the survey data file**
2. **Generate a results card** using `send_card`:

```json
{
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "content": "📊 投票结果", "tag": "plain_text" },
    "template": "blue"
  },
  "elements": [
    { "tag": "markdown", "content": "**{survey_title}**" },
    { "tag": "markdown", "content": "共 {totalVotes} 人参与投票\n" },
    { "tag": "hr" },
    { "tag": "markdown", "content": "{result_lines_with_progress_bars}" },
    { "tag": "hr" },
    { "tag": "markdown", "content": "🏆 **{winning_option}** 以 {winning_votes} 票领先！" }
  ]
}
```

**Progress bar format** (using unicode blocks):

```
{label}: {votes}票 ({percentage}%)
████████░░░░░░░░
```

Use 16 characters total for the progress bar:
- `█` = (votes / totalVotes) * 16
- `░` = remaining

### Step 6: Close the Poll (Optional)

When the poll creator wants to close:

1. **Update the survey file**: set `"status": "closed"`
2. **Send final results card** with `🏆 投票已结束` header
3. **Announce the winner**

---

## Data File Management

### File Location

```
workspace/surveys/{chatId}/{messageId}.json
```

### Listing Active Surveys

To find all active surveys in a chat:

```bash
ls workspace/surveys/{chatId}/
# Then read each file and check status === "active"
```

### Cleanup

Survey data files should be kept for reference. No automatic cleanup needed.

---

## Important Notes

### Known Limitations (MVP)

1. **No user identity tracking**: The current system cannot identify which user clicked a button. Double-voting cannot be prevented.
2. **Single question only**: Multi-question surveys require multiple sequential polls.
3. **No automatic deadlines**: Polls don't auto-close; the creator must close manually.
4. **No anonymity**: All votes are processed in the same chat context.

### Future Enhancement Opportunities

These features would require infrastructure changes beyond the skill level:

| Feature | What's Needed |
|---------|---------------|
| User identity in callbacks | Primary Node webhook handler changes |
| Multi-question surveys | Survey session state management |
| Anonymous voting | Separate response channel |
| Automatic deadlines | Scheduler integration |
| Reminder mechanism | Scheduler + user tracking |

---

## Examples

### Example 1: Simple Lunch Poll

**User says**: "发起投票：今天午饭吃什么？A. 麻辣烫 B. 沙县小吃 C. 黄焖鸡 D. 随便"

**Agent creates survey file**:
```json
{
  "id": "cli-abc123",
  "chatId": "oc_xxx",
  "title": "今天午饭吃什么？",
  "options": [
    { "value": "opt_0", "label": "麻辣烫", "votes": 0 },
    { "value": "opt_1", "label": "沙县小吃", "votes": 0 },
    { "value": "opt_2", "label": "黄焖鸡", "votes": 0 },
    { "value": "opt_3", "label": "随便", "votes": 0 }
  ],
  "multiSelect": false,
  "createdAt": "2026-05-04T06:00:00Z",
  "status": "active",
  "totalVotes": 0
}
```

**Agent sends interactive card**:
```
send_interactive({
  question: "今天午饭吃什么？",
  options: [
    { text: "A. 麻辣烫", value: "opt_0" },
    { text: "B. 沙县小吃", value: "opt_1" },
    { text: "C. 黄焖鸡", value: "opt_2" },
    { text: "D. 随便", value: "opt_3" }
  ],
  title: "📊 午饭投票",
  chatId: "oc_xxx",
  actionPrompts: {
    "opt_0": "[投票] 用户选择了「麻辣烫」。请更新 workspace/surveys/oc_xxx/cli-abc123.json 中 opt_0 的 votes 和 totalVotes，然后简短确认。",
    "opt_1": "[投票] 用户选择了「沙县小吃」。请更新 workspace/surveys/oc_xxx/cli-abc123.json 中 opt_1 的 votes 和 totalVotes，然后简短确认。",
    "opt_2": "[投票] 用户选择了「黄焖鸡」。请更新 workspace/surveys/oc_xxx/cli-abc123.json 中 opt_2 的 votes 和 totalVotes，然后简短确认。",
    "opt_3": "[投票] 用户选择了「随便」。请更新 workspace/surveys/oc_xxx/cli-abc123.json 中 opt_3 的 votes 和 totalVotes，然后简短确认。"
  }
})
```

### Example 2: Satisfaction Rating

**User says**: "帮我发一个满意度调查，1-5星评价今天的技术分享"

**Agent creates survey file and sends card with 5 star options.**

### Example 3: Yes/No Decision

**User says**: "投票：是否同意将代码审查从周五改到周六？"

**Agent creates a 3-option poll**: 同意 / 不同意 / 弃权

---

## DO NOT

- ❌ Create complex multi-page surveys (use external tools)
- ❌ Promise anonymity (current system cannot guarantee it)
- ❌ Auto-close polls without explicit user request
- ❌ Delete survey data files after closing (keep for reference)
- ❌ Reveal individual vote details to other participants
- ❌ Send results cards unsolicited (only when requested or when poll closes)
