---
name: survey-poll
description: Lightweight survey and polling skill - create polls, collect votes, and display results via interactive cards. Use when user says "发起投票", "创建问卷", "收集反馈", "survey", "poll", "vote", "问卷调查".
allowed-tools: [Bash]
---

# Survey & Poll Skill

Create lightweight polls and surveys using interactive Feishu cards. Collect responses from group members and display aggregated results.

## When to Use This Skill

**Keywords that trigger this skill**: "发起投票", "创建问卷", "收集反馈", "投票", "问卷调查", "survey", "poll", "vote", "feedback collection"

**Typical scenarios:**
- Team decision making (e.g., choosing a restaurant, meeting time)
- Quick feedback collection (e.g., satisfaction rating)
- Opinion polling on a specific topic
- Multi-choice preference survey

## Single Responsibility

- ✅ Create poll/survey cards with options
- ✅ Track and aggregate responses
- ✅ Display results with visual summary
- ❌ DO NOT implement complex multi-page surveys (future phase)
- ❌ DO NOT implement anonymous voting (future phase)

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Poll Types

### Type 1: Single-Choice Poll (Most Common)

A poll where each participant selects exactly one option.

```
User: "发起一个投票：下周团建去哪里？选项：火锅、烤肉、日料"
```

### Type 2: Rating Poll

A poll for rating/satisfaction on a scale.

```
User: "大家对这次活动的满意度打个分"
```

### Type 3: Yes/No Decision

A simple binary choice for decision making.

```
User: "我们是否应该采用新方案？"
```

---

## Step-by-Step Workflow

### Step 1: Parse User Request

Extract from the user's message:
- **Question/Topic**: What is being asked
- **Options**: Available choices (if not provided, generate reasonable defaults)
- **Poll type**: single-choice (default), rating, or yes/no

**If the user doesn't specify options**, suggest 2-4 reasonable options based on the question context.

### Step 2: Create the Poll Card

Use `send_interactive` to create the poll card. Include clear instructions and action prompts that help track votes.

```typescript
// Example: Restaurant team-building poll
send_interactive({
  question: "下周团建去哪里？请在下方选择你喜欢的餐厅类型：\n\n请每位同学投票，每人一票 🗳️",
  options: [
    { text: "🍲 火锅", value: "hotpot", type: "primary" },
    { text: "🥩 烤肉", value: "bbq" },
    { text: "🍣 日料", value: "japanese" },
    { text: "🥗 轻食", value: "salad" },
  ],
  title: "📊 团建投票",
  context: "发起人: {sender_name} | 截止时间: 发起人确认后关闭",
  chatId: "{chatId}",
  actionPrompts: {
    hotpot: "[投票] 用户选择了「🍲 火锅」。记录此投票并确认。",
    bbq: "[投票] 用户选择了「🥩 烤肉」。记录此投票并确认。",
    japanese: "[投票] 用户选择了「🍣 日料」。记录此投票并确认。",
    salad: "[投票] 用户选择了「🥗 轻食」。记录此投票并确认。",
  }
})
```

### Step 3: Track Votes

**IMPORTANT**: Maintain a vote tracking record in the conversation. When a user clicks a button:

1. The `actionPrompts` will generate a message like `[投票] 用户选择了「🍲 火锅」。记录此投票并确认。`
2. Record the vote with the sender's identity
3. Send a brief confirmation to the voter

**Vote tracking format** (maintain in your conversation context):

```
📊 投票记录: {poll_title}
- 🍲 火锅: @user1, @user3 (2票)
- 🥩 烤肉: @user2 (1票)
- 🍣 日料: (0票)
- 🥗 轻食: @user4 (1票)
总计: 4/10 已投票
```

**When a user votes:**
- If they haven't voted yet → Add their vote and confirm: `✅ 已记录你的投票: {option}`
- If they've already voted → Update their vote: `✅ 已更新你的投票为: {option}（原: {old_option}）`
- If the poll is closed → Inform them: `❌ 投票已结束`

### Step 4: Display Results

When the poll creator asks for results (or says "结束投票", "查看结果"), use `send_card` to display an aggregated summary:

```typescript
send_card({
  chatId: "{chatId}",
  card: {
    config: { wide_screen_mode: true },
    header: {
      title: { content: "📊 投票结果", tag: "plain_text" },
      template: "green"
    },
    elements: [
      { tag: "markdown", content: "**题目**: 下周团建去哪里？\n**参与人数**: 4/10" },
      { tag: "hr" },
      { tag: "markdown", content: "🍲 火锅 — ██░░░░░░░░ 2票 (50%)\n🥩 烤肉 — █░░░░░░░░░ 1票 (25%)\n🍣 日料 — ░░░░░░░░░░ 0票 (0%)\n🥗 轻食 — █░░░░░░░░░ 1票 (25%)" },
      { tag: "hr" },
      { tag: "markdown", content: "🏆 **最受欢迎**: 🍲 火锅" }
    ]
  }
})
```

**Result bar chart format:**

Use Unicode block characters to create a simple visual bar chart:
- `█` for filled (each █ ≈ 10%)
- `░` for empty
- Example: `███░░░░░░░ 3票 (30%)`

**Calculate bars:**
```
const barLength = 10;
const filled = Math.round((votes / totalVotes) * barLength);
const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);
```

---

## Rating Poll Template

For satisfaction/rating polls, use a 1-5 scale:

```typescript
send_interactive({
  question: "请对本次活动进行评分：",
  options: [
    { text: "⭐⭐⭐⭐⭐ 非常满意", value: "5" },
    { text: "⭐⭐⭐⭐ 满意", value: "4" },
    { text: "⭐⭐⭐ 一般", value: "3" },
    { text: "⭐⭐ 不太满意", value: "2" },
    { text: "⭐ 不满意", value: "1", type: "danger" },
  ],
  title: "📊 满意度评分",
  chatId: "{chatId}",
  actionPrompts: {
    "5": "[评分] 用户评了 ⭐⭐⭐⭐⭐ (5分)。记录此评分。",
    "4": "[评分] 用户评了 ⭐⭐⭐⭐ (4分)。记录此评分。",
    "3": "[评分] 用户评了 ⭐⭐⭐ (3分)。记录此评分。",
    "2": "[评分] 用户评了 ⭐⭐ (2分)。记录此评分。",
    "1": "[评分] 用户评了 ⭐ (1分)。记录此评分。",
  }
})
```

**Rating result display:**
```
⭐⭐⭐⭐⭐ ██████░░░░ 3人 (平均: 4.2分)
⭐⭐⭐⭐  ████░░░░░░ 2人
⭐⭐⭐    ██░░░░░░░░ 1人
⭐⭐      ░░░░░░░░░░ 0人
⭐        ░░░░░░░░░░ 0人

📊 平均分: 4.2 / 5.0 (共6人评分)
```

---

## Yes/No Decision Template

For binary decisions:

```typescript
send_interactive({
  question: "是否采用新方案？\n\n请在下方选择你的立场：",
  options: [
    { text: "✅ 赞成", value: "yes", type: "primary" },
    { text: "❌ 反对", value: "no", type: "danger" },
  ],
  title: "📊 决策投票",
  context: "议题: 是否采用新方案",
  chatId: "{chatId}",
  actionPrompts: {
    yes: "[投票] 用户选择「✅ 赞成」。记录此投票。",
    no: "[投票] 用户选择「❌ 反对」。记录此投票。",
  }
})
```

---

## Important Guidelines

### Creating Polls

1. **Clear title**: Always include a descriptive title with 📊 emoji
2. **Limited options**: Keep to 2-6 options for best UX
3. **Emoji prefixes**: Use relevant emoji for each option to make them visually distinct
4. **Action prompts**: Always include action prompts that help identify votes
5. **Instructions**: Include brief instructions in the question text (e.g., "每人一票")

### Tracking Votes

1. **User identity**: Track by sender open_id to prevent duplicate votes
2. **Real-time updates**: Confirm each vote immediately after it's cast
3. **Change handling**: Allow users to change their vote before poll closes
4. **Running tally**: Keep a running count visible in the conversation

### Displaying Results

1. **Visual format**: Always use the bar chart format for results
2. **Winner highlight**: Clearly indicate the winning option with 🏆
3. **Participation stats**: Show how many people voted vs. total
4. **Average scores**: For rating polls, show the average score

### Closing Polls

1. **Creator authority**: Only the poll creator (or group admin) can close a poll
2. **Announce results**: When closing, display the final results card
3. **No more votes**: After closing, reject any additional votes with a message

---

## DO NOT

- ❌ Allow multiple votes from the same user (detect and update instead)
- ❌ Create polls without clear options
- ❌ Forget to track votes in the conversation context
- ❌ Close a poll without displaying results first
- ❌ Create overly complex multi-question surveys (not supported in Phase 1)

---

## Limitations (Phase 1)

| Feature | Status | Notes |
|---------|--------|-------|
| Single-choice poll | ✅ Supported | Core functionality |
| Rating poll | ✅ Supported | 1-5 scale |
| Yes/No decision | ✅ Supported | Binary choice |
| Vote tracking | ✅ Supported | Per-user, conversation-scoped |
| Result display | ✅ Supported | Bar chart card |
| Multi-question survey | ❌ Phase 2 | Needs sequential card flow |
| Anonymous voting | ❌ Phase 2 | Needs special handling |
| Deadline/reminders | ❌ Phase 2 | Needs timer integration |
| Target specific users | ❌ Phase 2 | Needs user mention support |
| Persistent storage | ❌ Phase 2 | Currently conversation-scoped |

---

## Example Scenarios

### Scenario 1: Team Lunch Decision

**User**: "发起投票：中午吃什么？"

**Agent**: Creates poll with common lunch options (火锅, 炒菜, 面条, 轻食, 随便), tracks votes, and shows results when asked.

### Scenario 2: Meeting Time Poll

**User**: "我们什么时候开复盘会？选项：周一上午、周三下午、周五上午"

**Agent**: Creates poll with the 3 time options, collects availability, and identifies the best time.

### Scenario 3: Satisfaction Survey

**User**: "给昨天的培训打个分"

**Agent**: Creates a 1-5 rating poll, collects scores, and displays average rating with distribution.
