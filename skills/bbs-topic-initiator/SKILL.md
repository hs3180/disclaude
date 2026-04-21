---
name: bbs-topic-initiator
description: AI BBS topic initiator - proactively generates engaging discussion topics for BBS/topic groups. Use when user asks for topic generation, community engagement, or says keywords like "发起话题", "生成话题", "社区活跃", "BBS话题", "每日话题", "topic generation".
allowed-tools: Read, Glob, Grep, Bash, WebSearch
---

# BBS Topic Initiator

Proactively generate engaging discussion topics for BBS/topic groups to maintain community engagement.

## When to Use This Skill

**Use this skill for:**
- Proactively initiating discussion topics in BBS/topic groups
- Maintaining community activity when engagement is low
- Generating topics based on current trends or project context
- Creating daily/periodic discussion starters

**Keywords that trigger this skill**: "发起话题", "生成话题", "社区活跃", "BBS话题", "每日话题", "topic generation", "start discussion", "community engagement"

## Core Principle

**Use prompt-based analysis, NOT complex program modules.**

The LLM should analyze context and generate engaging topics directly, not through pre-built algorithms.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Topic Generation Process

### Step 1: Analyze Current Context

1. **Read recent chat history** from `workspace/chat/{chatId}.md`:
   ```bash
   cat workspace/chat/{chatId}.md | tail -200
   ```

2. **Check project context** (if applicable):
   - Recent GitHub issues/PRs
   - Current development focus
   - Team discussions

3. **Identify engagement level**:
   - When was the last message?
   - What topics were discussed recently?
   - Are there any unanswered questions?

### Step 2: Determine Topic Strategy

Based on context analysis, choose an appropriate topic type:

| Topic Type | When to Use | Example |
|------------|-------------|---------|
| **Trending** | External tech news relevant to project | "Have you seen the new React 19 features?" |
| **Reflection** | Recent decisions or discussions | "Looking back at our architecture choice..." |
| **Challenge** | Interesting technical problems | "How would you solve X without Y?" |
| **Knowledge Sharing** | Team expertise areas | "What's your favorite debugging technique?" |
| **Casual** | Low engagement periods | "What's everyone working on this week?" |

### Step 3: Generate Topic

Create an engaging topic with these characteristics:

- **Open-ended**: Multiple valid perspectives
- **Relevant**: Connected to real work or team interests
- **Thought-provoking**: Makes people want to respond
- **Inclusive**: Everyone can participate

**Topic Template:**
```markdown
## 🎯 [Topic Type] 话题

{Hook - catchy opening}

{Context - why this matters}

**讨论问题：**
1. {Question 1}
2. {Question 2}
3. {Optional follow-up}

---
💬 欢迎分享你的想法！
```

### Step 4: Send to Target Group

Use the `send_user_feedback` MCP tool to send the topic:

```
send_user_feedback({
  chatId: "{target_chat_id}",
  message: "{generated_topic}"
})
```

**Note**: Use the chatId from context or a configured target group.

---

## Topic Quality Guidelines

### Good Topics:
- ✅ Based on real context (project, team, trends)
- ✅ Open-ended with multiple valid perspectives
- ✅ Inclusive - everyone can contribute
- ✅ Timely - relevant to current events/season
- ✅ Engaging - sparks curiosity or emotion

### Avoid:
- ❌ Yes/no questions
- ❌ Topics that exclude certain team members
- ❌ Controversial subjects (politics, religion)
- ❌ Topics that criticize specific people
- ❌ Overly technical questions only experts can answer
- ❌ Generic topics without personal touch

---

## Example Scenarios

### Scenario 1: Low Engagement Detection

**Context**: No messages in 24 hours

**Generated Topic:**
```markdown
## 🎯 每周分享 话题

这周大家都在忙什么有趣的事情？

发现好久没动静了，来聊聊吧！

**分享问题：**
1. 本周最有成就感的事情是什么？
2. 遇到了什么有趣的技术挑战？
3. 有什么想吐槽的吗？

---
💬 随便聊聊，不需要太正式！
```

### Scenario 2: Trending Tech News

**Context**: New major release of a framework the team uses

**Generated Topic:**
```markdown
## 🎯 技术前沿 话题

React 19 正式发布了！🎉

新特性包括：
- Server Components 稳定版
- 新的 use() hook
- 自动批处理改进

**讨论问题：**
1. 你们打算升级吗？有什么顾虑？
2. 哪个新特性最吸引你？
3. 有什么潜在的坑需要关注？

---
💬 分享你的想法和升级计划！
```

### Scenario 3: Knowledge Sharing

**Context**: Team has been debugging performance issues

**Generated Topic:**
```markdown
## 🎯 经验分享 话题

聊聊调试技巧 💡

最近看到大家在处理性能问题，想收集一些经验。

**讨论问题：**
1. 你最常用的调试工具是什么？
2. 有什么"独门秘籍"愿意分享？
3. 遇到过最棘手的 bug 是什么？

---
💬 每个人都有值得分享的经验！
```

---

## Configuration

### Schedule Configuration

To enable automatic topic initiation, create a schedule file in `schedules/<name>/SCHEDULE.md`:

```markdown
---
name: "BBS 话题发起"
cron: "0 9,15 * * 1-5"  # 9am and 3pm on weekdays
enabled: true
blocking: true
chatId: "{your_bbs_group_chat_id}"
---

请使用 bbs-topic-initiator skill 为当前群组生成一个话题。

要求：
1. 读取 workspace/chat/{chatId}.md 分析最近的讨论
2. 根据上下文选择合适的话题类型
3. 生成一个开放式的、引人参与的话题
4. 使用 send_user_feedback 发送到当前 chatId

注意：
- 如果最近已有活跃讨论，跳过本次
- 避免重复相似的话题
- 保持话题的多样性和趣味性
```

### Topic Categories Configuration

You can customize topic categories by creating `workspace/data/bbs-topics.yaml`:

```yaml
categories:
  - name: "技术讨论"
    keywords: ["技术", "架构", "代码"]
    frequency: "high"

  - name: "经验分享"
    keywords: ["经验", "技巧", "最佳实践"]
    frequency: "medium"

  - name: "轻松闲聊"
    keywords: ["周末", "兴趣", "生活"]
    frequency: "low"

cooldown:
  min_interval_hours: 4
  max_daily_topics: 3
```

---

## Integration with Other Skills

- **daily-soul-question**: Use for deeper reflection questions
- **schedule-recommend**: Analyze when topics get most engagement

---

## Checklist

- [ ] Read recent chat history from `workspace/chat/`
- [ ] Analyzed engagement level and context
- [ ] Chose appropriate topic type
- [ ] Generated open-ended, engaging topic
- [ ] Topic is inclusive and relevant
- [ ] Ready to send using `send_user_feedback`

---

## DO NOT

- Generate topics without analyzing context first
- Create topics that could be controversial or offensive
- Send multiple topics in short succession (respect cooldown)
- Copy-paste generic topics without personalization
- Ignore recent discussion themes (avoid repetition)
