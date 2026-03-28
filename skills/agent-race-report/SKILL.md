---
name: agent-race-report
description: Agent framework comparison and benchmarking specialist - analyzes chat logs to evaluate and compare different agent frameworks, models, and providers. Generates structured performance reports highlighting strengths, weaknesses, and unique characteristics. Use for framework evaluation, model comparison, or when user says keywords like "赛马", "框架对比", "模型评估", "agent benchmark", "framework comparison", "race report". Can be triggered by scheduler for periodic automated execution.
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Agent Race Report

Analyze chat logs to evaluate and compare different Agent frameworks, models, and providers. Generate structured benchmarking reports.

## When to Use This Skill

**Use this skill for:**
- Periodic Agent framework performance evaluation
- Model/provider comparison across different task types
- Identifying which framework excels at which type of work
- Generating structured comparison reports for decision-making
- Tracking performance trends over time

**Keywords that trigger this skill**: "赛马", "框架对比", "模型评估", "agent benchmark", "framework comparison", "race report", "性能报告"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based analysis to compare agent performance from chat history.**

The analysis focuses on two aspects:
1. **Quantifiable metrics** (可以赛马的): response time, cost, task completion rate, error rate
2. **Unique characteristics** (无法赛马的): qualitative strengths that make each framework special

---

## Analysis Process

### Step 1: Collect Chat Logs

Read chat log files from the chat logs directory:

```
workspace/chat/
├── 2026-03-25/
│   ├── oc_chat1.md
│   └── oc_chat2.md
├── 2026-03-26/
│   ├── oc_chat1.md
│   └── oc_chat3.md
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/chat/**/*.md`
2. Read each log file with `Read` tool
3. Focus on recent logs (default: last 7 days, configurable via analysis period)
4. If logs directory is empty or doesn't exist, report accordingly

### Step 2: Extract Metrics

For each conversation, analyze and extract:

#### 2.1 Quantifiable Metrics (可量化指标)

| Metric | How to Extract | Unit |
|--------|---------------|------|
| **Response Time** | Time difference between user message timestamp and bot response timestamp | Seconds |
| **Task Completion Rate** | Analyze conversation flow - did the task reach a conclusion? | Percentage |
| **Conversation Turns** | Count of user-bot exchange pairs | Count |
| **Error Rate** | Count error indicators: "失败", "错误", "timeout", "retry", "exception" | Percentage |
| **User Satisfaction** | Detect signals: "谢谢", "好的", "完美" (positive) vs "不对", "重新来", "报错" (negative) | Sentiment |
| **Tool Usage Efficiency** | Count tool calls vs task complexity (number of sub-tasks) | Ratio |
| **Cost Efficiency** | If cost/token data available in logs, compare cost per task | USD |

#### 2.2 Unique Characteristics (独特特性)

Analyze qualitative aspects that cannot be directly compared:
- **Reasoning Style**: Step-by-step analytical vs intuitive leaps
- **Creativity**: Novel approaches vs formulaic solutions
- **Communication Style**: Concise vs detailed, formal vs casual
- **Error Recovery**: How gracefully the agent handles failures
- **Context Retention**: How well it maintains context across long conversations
- **Proactivity**: Does it anticipate follow-up needs?

### Step 3: Classify Tasks

Group conversations by task type for fair comparison:

| Task Type | Indicators | Examples |
|-----------|-----------|---------|
| **Coding** | Code blocks, file edits, git commands | Bug fixes, feature implementation |
| **Research** | Web searches, file reading, analysis | Issue investigation, code review |
| **Communication** | Message sending, card creation | Reports, notifications |
| **Automation** | Scheduled tasks, skill creation | CI/CD, monitoring |
| **Discussion** | Q&A, brainstorming | Architecture decisions |

### Step 4: Generate Report

Create a structured comparison report:

```markdown
## 🏁 Agent Framework 赛马报告

**分析时间**: [Timestamp]
**分析范围**: [Date range]
**分析会话数**: [Number of conversations analyzed]
**涉及模型**: [List of models/providers identified]

---

### 📊 量化指标对比

| 指标 | [Model A] | [Model B] | [Model C] |
|------|-----------|-----------|-----------|
| 平均响应时间 | Xs | Xs | Xs |
| 任务完成率 | X% | X% | X% |
| 平均对话轮次 | X | X | X |
| 错误率 | X% | X% | X% |
| 用户满意度 | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |

---

### 🏆 各任务类型最佳表现

| 任务类型 | 最佳模型 | 关键优势 |
|----------|---------|---------|
| Coding | [Model] | [Why it's best] |
| Research | [Model] | [Why it's best] |
| Communication | [Model] | [Why it's best] |

---

### 🎨 独特特性分析（无法赛马的部分）

#### [Model A]
- **风格特点**: [Description of unique style]
- **擅长场景**: [Scenarios where it shines]
- **不适合场景**: [Scenarios where it struggles]

#### [Model B]
- **风格特点**: [Description]
- **擅长场景**: [Scenarios]
- **不适合场景**: [Scenarios]

---

### 📈 趋势观察（如有历史数据）

- [Performance trend observations]
- [Model usage pattern changes]
- [Notable improvements or regressions]

---

### 💡 建议

1. **短期**: [Immediate recommendations]
2. **长期**: [Strategic recommendations]
3. **注意事项**: [Caveats and limitations of this analysis]
```

### Step 5: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Analysis Guidelines

### Fair Comparison Rules

1. **Same task type only**: Don't compare coding performance against research tasks
2. **Sufficient sample size**: At least 3 conversations per model per task type for statistical significance
3. **Acknowledge limitations**: Small sample sizes should be flagged
4. **Context matters**: Consider task difficulty - a complex task taking longer isn't necessarily worse

### What to Highlight

| Aspect | Why It Matters |
|--------|---------------|
| **Cost-effectiveness** | Cheaper isn't always better - consider quality |
| **Speed vs Quality tradeoff** | Fast responses that need correction cost more overall |
| **Error recovery** | An agent that fails gracefully is more reliable |
| **Consistency** | Low variance in performance is often more valuable than peak performance |

### What to Avoid

- Over-interpreting small sample sizes
- Declaring a "winner" without sufficient data
- Ignoring qualitative differences
- Making recommendations without evidence

---

## Integration with Scheduled Tasks

This skill can be triggered as a scheduled task for periodic evaluation:

```yaml
---
name: "weekly-agent-race-report"
cron: "0 9 * * 1"
enabled: true
blocking: true
chatId: "REPLACE_WITH_TARGET_CHAT_ID"
---

请执行 agent-race-report 分析，生成上周的 Agent 框架赛马报告。
分析范围：过去 7 天。
```

---

## Checklist

- [ ] Collected chat logs from workspace/chat/
- [ ] Extracted quantifiable metrics (response time, completion rate, error rate)
- [ ] Identified unique characteristics for each model/framework
- [ ] Classified tasks by type for fair comparison
- [ ] Generated structured report with tables
- [ ] Highlighted unique characteristics that can't be quantified
- [ ] Flagged sample size limitations if applicable
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core code or BaseAgent
- Declare a definitive "winner" without sufficient evidence
- Ignore qualitative differences between frameworks
- Skip the send_user_feedback step
- Create schedules without user confirmation
- Include sensitive information in reports
