---
name: agent-benchmark
description: Agent Framework performance benchmarking specialist - analyzes chat history to evaluate and compare different Agent providers/models. Generates structured comparison reports with metrics like response efficiency, task completion rate, user satisfaction, and error rates. Use for performance reviews, framework comparison, or when user says keywords like "框架赛马", "性能对比", "框架评估", "benchmark", "framework comparison". Can be triggered by scheduler for periodic evaluation.
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Agent Benchmark

Analyze chat history to evaluate and compare different Agent Framework/Provider performance, generating structured benchmark reports.

## When to Use This Skill

**Use this skill for:**
- Periodic Agent framework/provider performance evaluation
- Comparing different models (e.g., Claude vs GPT vs Gemini) on real user interactions
- Identifying which provider excels at which task types
- Tracking agent performance trends over time
- Generating weekly/monthly benchmark reports

**Keywords that trigger this skill**: "框架赛马", "性能对比", "框架评估", "benchmark", "framework comparison", "agent 评估", "模型对比", "赛马"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Evaluate agent performance through real user interaction analysis, not synthetic benchmarks.**

This skill analyzes actual chat logs to measure how different Agent providers/models perform in production:
- **No code intrusion** - Does not modify BaseAgent or any core code
- **LLM-driven analysis** - Uses the agent's own intelligence to interpret qualitative differences
- **Real-world metrics** - Based on actual user interactions, not artificial test cases

---

## Analysis Process

### Step 1: Discover and Read Chat Logs

Find all available chat log files:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-03-25.md
│   └── 2026-03-26.md
├── oc_chat2/
│   └── 2026-03-26.md
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Read each log file with `Read` tool
3. Focus on the analysis period (default: last 7 days, configurable via prompt)

### Step 2: Extract Provider/Model Information

From each conversation, identify:
- **Provider**: anthropic, openai, google, etc.
- **Model**: claude-sonnet-4-20250514, gpt-4o, gemini-2.0-flash, etc.
- **Agent Type**: skillAgent, scheduleAgent, etc. (if identifiable from context)

Look for these indicators in the logs:
- System messages or metadata containing provider/model info
- Task execution context headers
- Error messages that mention specific models
- Scheduled task execution context (model parameter)

### Step 3: Analyze Performance Metrics

For each identified provider/model combination, evaluate:

#### 3.1 Response Efficiency (响应效率)
- **Response time**: Time between user message and agent response (from timestamps)
- **Conversation rounds**: How many turns to complete a task
- **First-response quality**: Does the agent understand the request on the first try?

#### 3.2 Task Completion Rate (任务完成度)
- **Completion signals**: Agent completed the task (user said thanks, marked done, etc.)
- **Abandon signals**: User gave up, asked to try differently, or task was never completed
- **Partial completion**: Task was partially done but needed follow-up

#### 3.3 User Satisfaction (用户满意度)
- **Positive signals**: "谢谢", "很好", "完美", "有用", "太棒了", thanks, great, perfect
- **Negative signals**: "不对", "重来", "不是这样的", "改一下", "错了", wrong, retry, fix
- **Neutral indicators**: Task completed without explicit feedback

#### 3.4 Error Patterns (错误率)
- **Execution errors**: Tool failures, timeout, API errors
- **Retry frequency**: How often the agent needed to retry operations
- **Self-correction**: Agent caught and fixed its own errors vs. user intervention needed

#### 3.5 Tool Usage Efficiency (工具使用效率)
- **Tools used per task**: Number of tool calls relative to task complexity
- **Appropriate tool selection**: Did the agent pick the right tool for the job?
- **Unnecessary operations**: Redundant tool calls or file operations

### Step 4: Categorize Task Types

Group conversations by task type for fair comparison:

| Task Type | Indicators |
|-----------|------------|
| Coding/Dev | File edits, code generation, PR creation, testing |
| Research/Analysis | Information gathering, web search, data analysis |
| System Admin | GitHub operations, configuration, deployment |
| Communication | Message sending, card interactions, feedback |
| Creative | Content generation, brainstorming, writing |

**Important**: Different models may excel at different task types. A model that scores lower overall might be the best at specific task categories.

### Step 5: Generate Benchmark Report

Create a structured comparison report:

```markdown
## 🏁 Agent Framework Benchmark Report

**Analysis Time**: [Timestamp]
**Analysis Period**: [Date Range]
**Chats Analyzed**: [Number]
**Total Conversations**: [Number]
**Providers Identified**: [List]

---

### 📊 Overall Rankings

| Rank | Provider/Model | Tasks | Completion Rate | Avg Satisfaction | Error Rate |
|------|---------------|-------|-----------------|-----------------|------------|
| 1 | [Provider] | [N] | [X%] | [Score] | [X%] |
| 2 | [Provider] | [N] | [X%] | [Score] | [X%] |
| 3 | [Provider] | [N] | [X%] | [Score] | [X%] |

---

### 🎯 Task-Type Breakdown

#### Coding/Development
| Provider | Tasks | Completion | Avg Rounds | Notes |
|----------|-------|------------|------------|-------|
| [Provider] | [N] | [X%] | [N] | [Qualitative notes] |

#### Research/Analysis
| Provider | Tasks | Completion | Avg Rounds | Notes |
|----------|-------|------------|------------|-------|
| [Provider] | [N] | [X%] | [N] | [Qualitative notes] |

#### System Administration
| Provider | Tasks | Completion | Avg Rounds | Notes |
|----------|-------|------------|------------|-------|
| [Provider] | [N] | [X%] | [N] | [Qualitative notes] |

---

### 💡 Key Findings

#### Strengths by Provider
- **[Provider A]**: Excels at [task type] - [specific evidence]
- **[Provider B]**: Best for [task type] - [specific evidence]

#### Weaknesses by Provider
- **[Provider A]**: Struggles with [task type] - [specific evidence]
- **[Provider B]**: [Issue description] - [specific evidence]

#### Notable Observations
- [Unique qualitative finding that pure metrics can't capture]
- [Pattern or trend worth highlighting]

---

### 📈 Trend Analysis (if applicable)

Comparison with previous report (if available):
- Performance changes since last report
- Emerging patterns or regressions
- Recommendations based on trends

---

### ✅ Recommendations

1. **Primary Provider**: Recommend [Provider] for general tasks because [reason]
2. **Specialized Use**: Use [Provider] for [specific task type] because [reason]
3. **Cost Optimization**: Consider [Provider] for [scenario] to reduce costs by [X%]
4. **Areas to Monitor**: [Provider] shows [concerning pattern] that needs attention
```

### Step 6: Save and Send Report

**CRITICAL**: Always send the report to the user using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The benchmark report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

Optionally, save the report to a file for historical tracking:
```
Save report to: workspace/logs/benchmark-reports/[date]-benchmark.md
```

---

## Analysis Guidelines

### What to Measure

| Metric | How to Detect | Weight |
|--------|---------------|--------|
| Task Completion | User satisfaction signals, task markers | High |
| Response Quality | User corrections needed, rework frequency | High |
| Efficiency | Conversation rounds, tool calls per task | Medium |
| Error Handling | Self-correction vs. user intervention needed | Medium |
| Responsiveness | Time between messages (if timestamps available) | Low |

### Fair Comparison Rules

1. **Same task type only**: Don't compare coding tasks against simple Q&A
2. **Minimum sample size**: Require at least 3 tasks per provider for ranking
3. **Confidence levels**: Mark rankings as "preliminary" if sample size < 5
4. **Qualitative context**: Always include qualitative observations alongside metrics

### What to Ignore

- Test/debug conversations
- System health check messages
- Scheduled task metadata (not user-facing interactions)
- Conversations with fewer than 2 user messages
- Automated status reports

---

## Example Analysis

### Input (Chat Log Excerpt):

```
## [2026-03-25T10:15:00Z] 📥 User
帮我修复 issue #123 的 bug

## [2026-03-25T10:15:30Z] 📤 Bot (anthropic/claude-sonnet-4)
我来分析这个 issue...
[Reads code, identifies bug, creates fix PR]

## [2026-03-25T10:25:00Z] 📥 User
谢谢，PR 看起来不错 👍
```

### Output (Report Section):

```markdown
#### Task: Bug Fix (issue #123)
- **Provider**: anthropic/claude-sonnet-4
- **Completion**: ✅ Complete (user confirmed with thanks)
- **Rounds**: 1 (single-pass resolution)
- **Tools Used**: 5 (Read × 3, Edit × 1, Bash × 1)
- **User Satisfaction**: ⭐⭐⭐⭐⭐ (explicit positive feedback)
```

---

## Integration with Scheduler

This skill can be triggered by a scheduled task for periodic benchmarking:

```yaml
# Example schedule configuration
name: "weekly-agent-benchmark"
cron: "0 9 * * 1"  # Every Monday 9:00
enabled: true
prompt: |
  使用 agent-benchmark skill 分析过去一周的聊天记录，
  生成 Agent Framework 性能对比报告。
  分析范围：最近 7 天。
```

---

## Checklist

- [ ] Read all chat log files from workspace/logs/
- [ ] Identified provider/model for each conversation
- [ ] Analyzed at least 3 performance dimensions per provider
- [ ] Categorized tasks by type for fair comparison
- [ ] Generated structured benchmark report with rankings
- [ ] Included qualitative findings alongside metrics
- [ ] **Sent report via send_user_feedback** (CRITICAL)
- [ ] Saved report to workspace/logs/benchmark-reports/ (optional)

---

## DO NOT

- Modify any core code (BaseAgent, SDK, etc.) - this is a pure analysis skill
- Create synthetic benchmarks or test cases
- Make definitive claims with insufficient data (mark as "preliminary")
- Include sensitive user information in reports
- Compare providers across different task types unfairly
- Send reports to wrong chatId
- Skip the send_user_feedback step
