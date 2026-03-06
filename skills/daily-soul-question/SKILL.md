---
name: daily-soul-question
description: Daily soul-searching question generator - analyzes chat/work records and generates thought-provoking discussion topics. Use when user asks for daily reflection, soul questions, or says keywords like "灵魂拷问", "每日反思", "话题讨论", "soul question", "daily reflection".
allowed-tools: Read, Glob, Grep, Bash
---

# Daily Soul Question

Analyze chat/work records and generate thought-provoking questions for group discussion.

## When to Use This Skill

**Use this skill for:**
- Generating daily reflection questions from chat history
- Creating discussion topics for BBS-style topic groups
- Identifying interesting decisions, potential improvements, and reflection-worthy issues

**Keywords that trigger this skill**: "灵魂拷问", "每日反思", "话题讨论", "soul question", "daily reflection", "生成话题"

## Core Principle

**Use prompt-based analysis, NOT complex program modules.**

The LLM should analyze chat history directly and generate thoughtful questions, not through pre-built algorithms.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Analysis Process

### Step 1: Read Chat History

Read the chat history files from `workspace/chat/` directory:

1. List all chat history files:
```bash
ls -la workspace/chat/*.md
```

2. Read recent messages (last 7 days) from relevant chats:
```bash
# For each relevant chat, read the history
cat workspace/chat/{chatId}.md | tail -500
```

### Step 2: Analyze Records (Prompt-Based)

Analyze the chat/work records to identify:

1. **Interesting Decisions**: Notable choices made during discussions
   - Technical decisions (architecture, tool choices)
   - Process decisions (workflow changes, priorities)
   - Any decision that sparked debate or consideration

2. **Potential Improvements**: Areas that could be enhanced
   - Recurring issues or pain points
   - Inefficiencies noticed
   - Technical debt mentioned

3. **Reflection-Worthy Issues**: Topics that deserve deeper thinking
   - Unanswered questions
   - Trade-offs that weren't fully explored
   - Assumptions that might need validation

### Step 3: Generate Soul Question

Create a thought-provoking question that:

- **Opens discussion** (not yes/no question)
- **Connects to real work** (based on actual records)
- **Invites diverse perspectives** (no single right answer)
- **Is relevant today** (recent context)

**Question Template:**
```markdown
## 🤔 今日灵魂拷问

分析今天的聊天/工作记录，发现一个有趣的问题：

「{核心问题}」

{背景说明}

{引导思考的问题}

欢迎在群里讨论 👇
```

### Step 4: Send to Topic Group

Use the `send_user_feedback` MCP tool to send the question:

```
send_user_feedback({
  chatId: "{target_chat_id}",
  message: "{generated_question}"
})
```

**Note**: The target chat ID should be configured in the schedule file or use the current chat.

---

## Example Analysis

### Input (Chat History Excerpt):

```
## [2024-01-15T10:00:00Z] 📥 User
我们在处理 #123 时选择了方案 A 而非方案 B，因为方案 A 更简单

## [2024-01-15T10:05:00Z] 📥 User
但方案 B 的扩展性更好，只是需要更多时间

## [2024-01-15T10:10:00Z] 📤 Bot
理解，这是一个典型的权衡：简单性 vs 扩展性
```

### Output (Soul Question):

```markdown
## 🤔 今日灵魂拷问

分析今天的聊天/工作记录，发现一个有趣的问题：

「在处理 #123 时，我们选择了方案 A（简单）而非方案 B（扩展性好）。这个决策是否正确？」

背景：
- 方案 A 更简单，可以快速实现
- 方案 B 扩展性更好，但需要更多时间

值得思考：
1. 我们是否低估了未来的扩展需求？
2. "简单优先"在什么情况下是正确的策略？
3. 如果重来一次，你会做同样的选择吗？

欢迎在群里讨论 👇
```

---

## Quality Guidelines

### Good Soul Questions:
- ✅ Based on actual work/decisions
- ✅ Open-ended (multiple valid perspectives)
- ✅ Thought-provoking (makes people think)
- ✅ Relevant to the team

### Avoid:
- ❌ Yes/no questions
- ❌ Questions with obvious answers
- ❌ Questions that criticize specific people
- ❌ Questions unrelated to actual work

---

## Schedule Configuration

To enable daily soul questions, create a schedule file:

```markdown
---
name: "每日灵魂拷问"
cron: "0 10 * * *"  # Every day at 10:00 AM
enabled: true
blocking: true
chatId: "{your_topic_group_chat_id}"
---

请使用 daily-soul-question skill 分析最近的聊天记录，生成一个灵魂拷问并发送到当前群聊。

要求：
1. 读取 workspace/chat/ 目录下的聊天记录
2. 重点关注最近的决策、讨论和问题
3. 生成一个开放式的、引人思考的问题
4. 使用 send_user_feedback 发送到当前 chatId
```

---

## Checklist

- [ ] Read chat history from `workspace/chat/`
- [ ] Identified interesting decisions or issues
- [ ] Generated open-ended, thought-provoking question
- [ ] Question is based on actual work context
- [ ] Ready to send using `send_user_feedback`

---

## DO NOT

- Generate questions that criticize individuals
- Create questions unrelated to actual work
- Ask yes/no questions
- Skip the analysis and generate generic questions
- Send multiple questions (one per day is enough)
