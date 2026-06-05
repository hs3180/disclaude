---
name: daily-news-inspiration
description: Daily news inspiration question generator - browses latest social and tech news, extracts inspiration, and generates natural questions. Use when user asks for news-based questions, daily inspiration, or says keywords like "新闻灵感", "每日提问", "时事提问", "新闻提问", "news inspiration", "daily news question".
allowed-tools: Read, Glob, Grep, Bash, WebSearch
---

# Daily News Inspiration

Browse the latest social and tech news daily, extract inspiration, and generate a natural question to simulate real-user interaction.

## When to Use This Skill

**Use this skill for:**
- Generating daily questions based on current news
- Testing disclaude's ability to respond to current events
- Discovering interesting discussion topics from news

**Keywords that trigger this skill**: "新闻灵感", "每日提问", "时事提问", "新闻提问", "news inspiration", "daily news question"

## Core Principle

**Natural divergence, not templated questions.**

The question should feel like a real user saw the news and naturally wanted to discuss it. Do NOT use preset question templates.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Execution Process

### Step 1: Browse Latest News

Use WebSearch to browse today's latest social and tech news. Focus on two categories:

1. **Social news** (社会新闻): Major events, policy changes, cultural trends
2. **Tech news** (科技新闻): Product launches, AI breakthroughs, industry trends

Search queries:
```
WebSearch("今日社会新闻热点 2026")
WebSearch("今日科技新闻 AI 2026")
```

### Step 2: Select One News Item

From the search results, pick **one** news item that:
- Is genuinely interesting or thought-provoking
- Has potential for deeper discussion
- Is relevant to the user's context (tech-savvy, uses AI tools)
- Is NOT purely negative or sensational

**Selection criteria**:
- Prefers tech/AI-related news (higher relevance)
- Prefers news with nuance (not just "X happened")
- Avoids purely political or controversial topics
- Avoids news that requires specialized domain knowledge

### Step 3: Generate Natural Question

Write a question in a **real user's voice**, as if they just saw this news and wanted to discuss it.

**Question characteristics**:
- Natural, conversational tone (not formal or journalistic)
- Shows genuine curiosity or interest
- Open-ended (invites discussion, not yes/no)
- Brief background context (1-2 sentences) so the question is self-contained

**Question format**:
```markdown
{1-2 sentences of news background, casual tone}

{Natural follow-up question or curiosity}
```

### Step 4: Send Question

Use the `mcp__channel-mcp__send_text` tool to send the question to the target chat:

```
mcp__channel-mcp__send_text({
  text: "{generated question}",
  chatId: "{chatId}"
})
```

### Step 5: Observe and Evaluate (Internal)

After sending, mentally note (do NOT send to user):
- Did disclaude understand the news context?
- Was the response relevant and helpful?
- Any gaps or issues worth reporting?

If significant issues are found, create a GitHub issue for improvement.

---

## Question Type Variety

Rotate between different question types across days:

| Type | Description | Example |
|------|-------------|---------|
| **Analysis** | Asking for deeper analysis of a trend | "What's the real impact of X?" |
| **Opinion** | Asking for perspective on a development | "What do you think about X's approach?" |
| **Factual** | Asking about specific details | "How does X actually work?" |
| **Creative** | Asking for creative speculation | "What if X was applied to Y?" |
| **Comparison** | Asking to compare approaches | "X vs Y - which makes more sense?" |

---

## Quality Guidelines

### Good Questions:
- Based on real, current news
- Feels like a real person asking
- Open-ended with room for discussion
- Self-contained (includes enough context)
- Varied in type and topic

### Avoid:
- Yes/no questions
- Questions that need specialized knowledge to answer
- Questions about purely negative/tragic events
- Template-like or repetitive questions
- Questions that feel like a test rather than genuine curiosity
- Multiple questions per day (quality over quantity)

---

## Example

### Search Results:
- "GPT-5 released with multi-modal reasoning"
- "China's new data privacy regulation"
- "Quantum computing breakthrough at Google"

### Selected News:
GPT-5 with multi-modal reasoning (tech-relevant, interesting)

### Generated Question:

> 刚看到 GPT-5 发布了，据说支持多模态推理，能同时理解图片和文字的复杂关系了。你觉得这种能力对日常开发工作会有实际影响吗？还是说更多是概念上的进步？

---

## 安装步骤

### 1. 收集参数

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{controlChannelChatId}` | Yes | — | 目标群组 chatId（当前对话的 chatId） |
| `{cron}` | No | `0 9 * * *` | 执行频率（默认每天上午 9:00） |

### 2. 实例化 Schedule

读取 skill 目录中的 `schedule.md` 模板，替换占位符后写入 workspace：

```
# 1. 读取模板内容（使用 Read 工具）
模板路径: skills/daily-news-inspiration/schedule.md

# 2. 替换所有占位符
```

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的目标群组 chatId |
| `{cron}` | 实际的 cron 表达式（默认 `0 9 * * *`） |

```
# 4. 使用 Write 工具写入目标文件
目标路径: schedules/daily-news-inspiration/SCHEDULE.md
```

### 3. 验证

读取生成的 `schedules/daily-news-inspiration/SCHEDULE.md`，确认：
- frontmatter 中无未替换的占位符
- `chatId` 为实际 chatId
- `enabled: true`

---

## Integration with Other Skills

- **daily-soul-question**: Uses chat history; this skill uses external news
- **bbs-topic-initiator**: Broader topic generation; this skill focuses on news-based questions
- **self-experience**: The observation step aligns with dogfooding goals

---

## DO NOT

- Generate questions without actually browsing news first
- Send multiple questions in one day
- Use sensationalist or clickbait-style framing
- Ask about politically sensitive or controversial topics
- Include "I'm an AI" or "As a language model" framing in the question
- Generate the same type of question every day
