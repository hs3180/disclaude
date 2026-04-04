---
name: framework-benchmark
description: Agent Framework benchmark specialist - analyzes chat records across all chats to evaluate and compare Agent performance. Zero code intrusion, purely based on existing chat log analysis. Use when user says keywords like "框架赛马", "benchmark", "模型对比", "性能评估", "framework race", "agent evaluation". Can be triggered by scheduler for automated periodic reports.
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Agent Framework Benchmark

Analyze chat records to benchmark Agent Framework performance across different models, providers, and contexts. Zero code intrusion — purely reads existing chat logs.

## When to Use This Skill

**Use this skill for:**
- Benchmarking Agent Framework performance across chats
- Comparing different models/providers based on real interaction data
- Generating periodic performance evaluation reports
- Identifying which agent configurations excel at specific task types

**Keywords that trigger this skill**: "框架赛马", "benchmark", "模型对比", "性能评估", "framework race", "agent evaluation", "赛马", "评估报告"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero code intrusion. Analyze existing chat logs using LLM-based pattern recognition.**

This skill does NOT modify any core code. It reads chat history files and uses prompt-based analysis to evaluate Agent performance. The LLM interprets conversation patterns to extract meaningful metrics.

### What Makes This Different from Daily Chat Review

| Dimension | Daily Chat Review | Framework Benchmark |
|-----------|------------------|---------------------|
| Focus | Repetitive issues & improvement | Performance comparison |
| Output | Issue list + recommendations | Comparison table + rankings |
| Scope | Per-chat analysis | Cross-chat analysis |
| Goal | Identify problems | Evaluate quality |

---

## Analysis Process

### Step 1: Discover Chat Logs

Find all available chat log files:

```
chat/
├── 2026-03-05/
│   ├── oc_chat1.md
│   └── oc_chat2.md
├── 2026-03-06/
│   ├── oc_chat1.md
│   └── oc_chat3.md
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `chat/**/*.md`
2. Identify distinct chat IDs from the file paths
3. Determine the date range of available logs
4. Select a representative time window (default: last 7 days)

**Important**: Read as many chats as possible for a comprehensive benchmark. If there are too many files, prioritize recent dates and diverse chat IDs.

### Step 2: Read and Analyze Chat Records

For each chat, read the log files and analyze the following dimensions:

#### 2.1 Response Efficiency (响应效率)

Calculate from message timestamps:
- **Average response time**: Time between user message (👤) and bot response (🤖)
- **Response time distribution**: Fast (< 10s), Normal (10-60s), Slow (> 60s)
- **Concurrency patterns**: Multiple user messages before bot responds

```
👤 [2026-03-05T09:15:00.000Z] (msg_1)
Hello

---

🤖 [2026-03-05T09:15:12.500Z] (msg_2)
Hi there!

---
→ Response time: 12.5s
```

#### 2.2 Task Completion (任务完成度)

Analyze conversation patterns:
- **Clear resolution**: Conversation reaches a definitive end with task completed
- **Partial completion**: Task partially done, user followed up
- **Failed/Abandoned**: Error messages, user gave up, or topic changed without resolution
- **Multi-turn efficiency**: How many rounds needed to complete a task

**Indicators of success**:
- User says "谢谢", "好的", "收到", "完美", "搞定了"
- Bot provides final answer with clear structure
- Task result delivered (file created, PR submitted, etc.)

**Indicators of failure**:
- User repeats the same request
- Bot returns error messages
- User says "不对", "重来", "还是不行"
- Conversation ends abruptly without resolution

#### 2.3 User Feedback (用户反馈)

Identify satisfaction signals from user messages:
- **Positive**: "谢谢", "好的", "不错", "很好", "赞", thumbs up emojis
- **Negative**: "不对", "不行", "错了", "太慢", "没用", "别这样"
- **Neutral**: Follow-up questions, clarifications
- **Correction frequency**: How often user corrects bot output

#### 2.4 Tool Usage Efficiency (工具使用效率)

Analyze tool call patterns in bot messages:
- **Tool call indicators**: Messages containing "⏳ Running", tool names, file paths
- **Tool diversity**: Number of different tools used per task
- **Redundant calls**: Same tool called multiple times for same purpose
- **Tool success rate**: Errors vs successful tool outcomes

#### 2.5 Error Patterns (错误率)

Count and categorize errors:
- **API errors**: Network timeouts, rate limits, auth failures
- **Tool errors**: File not found, permission denied, invalid input
- **Logic errors**: Wrong answer, hallucination, incorrect analysis
- **Recovery**: Whether the agent recovered from errors autonomously

### Step 3: Cross-Chat Comparison

After analyzing individual chats, generate cross-chat comparisons:

#### 3.1 Per-Chat Summary Table

For each chat, produce:

| Chat ID | Messages Analyzed | Avg Response Time | Task Completion Rate | User Satisfaction | Error Count |
|---------|-------------------|-------------------|---------------------|-------------------|-------------|
| oc_xxx  | 156               | 8.2s              | 85%                 | Positive          | 3           |

#### 3.2 Overall Rankings

Rank chats by each dimension:
1. **Speed Ranking**: Fastest average response time
2. **Quality Ranking**: Highest task completion rate
3. **Satisfaction Ranking**: Best user feedback
4. **Reliability Ranking**: Lowest error rate
5. **Efficiency Ranking**: Best tool usage efficiency

#### 3.3 Strengths & Weaknesses

For each chat/context, identify:
- **Strengths**: What this agent configuration does best
- **Weaknesses**: Areas needing improvement
- **Unique capabilities**: Qualitative strengths that numbers can't capture

### Step 4: Generate Benchmark Report

Create a structured markdown report:

```markdown
## 🏁 Agent Framework Benchmark Report

**Report Time**: [Timestamp]
**Analysis Period**: [Date Range]
**Chats Analyzed**: [Number]
**Total Messages**: [Number]

---

### 📊 Overall Summary

| Rank | Chat ID | Messages | Avg Response | Completion | Satisfaction | Errors |
|------|---------|----------|-------------|------------|-------------|--------|
| 1    | oc_xxx  | 156      | 8.2s        | 85%        | 😊 Positive  | 3      |
| 2    | oc_yyy  | 89       | 12.5s       | 78%        | 😐 Neutral   | 7      |

---

### ⚡ Response Efficiency

| Chat ID | Avg Time | Fast (<10s) | Normal (10-60s) | Slow (>60s) |
|---------|----------|-------------|-----------------|-------------|
| oc_xxx  | 8.2s     | 72%         | 25%             | 3%          |

**Key Finding**: [Description of notable pattern]

---

### ✅ Task Completion

| Chat ID | Completed | Partial | Failed | Avg Rounds |
|---------|-----------|---------|--------|------------|
| oc_xxx  | 85%       | 10%     | 5%     | 3.2        |

**Key Finding**: [Description of notable pattern]

---

### 😊 User Satisfaction

| Chat ID | Positive | Neutral | Negative | Correction Rate |
|---------|----------|---------|----------|----------------|
| oc_xxx  | 45%      | 48%     | 7%       | 12%            |

**Key Finding**: [Description of notable pattern]

---

### 🔧 Tool Usage

| Chat ID | Tool Calls | Unique Tools | Redundant | Error Rate |
|---------|-----------|-------------|-----------|------------|
| oc_xxx  | 234       | 8           | 5%        | 3%         |

**Key Finding**: [Description of notable pattern]

---

### 🏆 Rankings

| Dimension | 🥇 Best | 🥈 Good | 🥉 Average |
|-----------|---------|---------|------------|
| Speed     | oc_xxx  | oc_yyy  | oc_zzz     |
| Quality   | oc_xxx  | oc_zzz  | oc_yyy     |
| Satisfaction | oc_zzz | oc_xxx  | oc_yyy     |
| Reliability | oc_xxx | oc_yyy  | oc_zzz     |
| Efficiency | oc_zzz | oc_xxx  | oc_yyy     |

---

### 💡 Key Insights

1. **[Insight 1]**: [Description with supporting evidence]
2. **[Insight 2]**: [Description with supporting evidence]
3. **[Insight 3]**: [Description with supporting evidence]

---

### 🎯 Unique Strengths (Beyond Numbers)

#### [Chat/Context A]
- **Unique capability**: [Qualitative description]
- **Evidence**: [Specific conversation examples]

#### [Chat/Context B]
- **Unique capability**: [Qualitative description]
- **Evidence**: [Specific conversation examples]

---

### 📋 Recommendations

1. **Immediate**: [Actionable improvement suggestion]
2. **Short-term**: [Optimization for next iteration]
3. **Long-term**: [Strategic direction]
```

### Step 5: Send Report

**CRITICAL**: Always send the report to the user using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Analysis Guidelines

### Minimum Data Requirements

| Metric | Minimum Data | Recommended |
|--------|-------------|-------------|
| Chats to analyze | 2 | 5+ |
| Days of history | 1 | 7 |
| Messages per chat | 10 | 50+ |

If minimum data is not available, state the limitation in the report and provide partial analysis.

### Statistical Approach

- Use **median** for response times (more robust than mean against outliers)
- Use **weighted average** for completion rates (weight by message count)
- Report **confidence level** based on sample size:
  - 10+ task completions: High confidence
  - 5-9 task completions: Medium confidence
  - < 5 task completions: Low confidence

### What to Analyze

| Pattern Type | Indicators |
|--------------|------------|
| Response Speed | Timestamps between 👤 and 🤖 |
| Task Success | Resolution keywords, final answers, deliverables |
| User Satisfaction | Emoji, explicit feedback, repeat requests |
| Tool Efficiency | Tool call indicators, error messages, retries |
| Error Rate | Error keywords, exception messages, retry patterns |

### What to Ignore

- System/internal messages without user context
- Scheduled task outputs (lack user interaction for feedback)
- Test/debug conversations
- Very short exchanges (< 3 messages) — insufficient for meaningful analysis

---

## Example Analysis

### Input (Chat Log Excerpt):

```
👤 [2026-03-05T09:15:00.000Z] (msg_1)
帮我检查一下 PR #200 的测试结果

---

🤖 [2026-03-05T09:15:08.500Z] (msg_2)
正在检查 PR #200 的测试状态...

⏳ Running Bash (2.1s)
⏳ Running Bash (1.3s)

PR #200 测试结果：所有 42 个测试用例通过 ✅

---

👤 [2026-03-05T09:16:00.000Z] (msg_3)
好的，谢谢

---
```

### Output (Analysis):

```markdown
#### Chat oc_xxx Analysis
- **Response time**: 8.5s (fast)
- **Task completion**: ✅ Complete (user confirmed with "好的，谢谢")
- **User feedback**: Positive (acknowledgment + thanks)
- **Tool usage**: 2 Bash calls, both successful, no redundancy
- **Rounds**: 1 (resolved in single exchange)
```

---

## Scheduler Integration

This skill is designed to work with the scheduler for automated periodic reports.

### Recommended Schedule Configuration

```yaml
schedules:
  - name: "weekly-framework-benchmark"
    cron: "0 9 * * 1"  # Every Monday 9:00
    prompt: "执行 framework-benchmark skill，分析过去一周的所有聊天记录，生成 Agent 框架性能评估报告。"
```

### Schedule Prompt Template

When triggered by scheduler, use this prompt:

```
执行 /framework-benchmark 分析过去 7 天的聊天记录。
重点关注：
1. 各群聊的响应效率对比
2. 任务完成质量排名
3. 用户满意度趋势
4. 异常错误模式

生成完整报告并通过 send_user_feedback 发送。
```

---

## Checklist

- [ ] Discovered all available chat log files using Glob
- [ ] Read logs from multiple chats for cross-chat comparison
- [ ] Analyzed response efficiency from timestamps
- [ ] Evaluated task completion from conversation patterns
- [ ] Identified user feedback signals
- [ ] Assessed tool usage efficiency
- [ ] Counted and categorized errors
- [ ] Generated structured comparison table
- [ ] Identified unique qualitative strengths
- [ ] Provided actionable recommendations
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core code or BaseAgent (zero intrusion principle)
- Create new log formats or structured metrics in code
- Make claims without supporting evidence from chat logs
- Compare chats with vastly different sample sizes without noting the disparity
- Skip chats just because they have fewer messages — include all available data
- Use hardcoded benchmark scores — all metrics must come from actual chat analysis
- Send reports to wrong chatId
- Skip the send_user_feedback step
