---
name: agent-benchmark
description: Agent Framework evaluation specialist - analyzes chat logs to compare agent performance across frameworks, models, and task types. Generates horse-race reports with quantitative metrics and qualitative insights. Use when user says keywords like "赛马", "benchmark", "agent评估", "framework比较", "performance report", "agent performance".
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Agent Benchmark - Framework Horse Race

Analyze chat histories to evaluate and compare agent performance across different frameworks, models, and task types.

## When to Use This Skill

**Use this skill for:**
- Periodic agent performance evaluation (scheduled)
- Comparing different models/providers on similar tasks
- Identifying strengths and weaknesses of agent configurations
- Generating performance reports for decision-making

**Keywords**: "赛马", "benchmark", "agent评估", "framework比较", "performance report", "agent performance", "horse race"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero code invasion** — analyze only existing chat logs. No modification to agent code, no new metrics collection, no logging changes.

The LLM analyzes message patterns and metadata from log files to evaluate agent performance.

---

## Analysis Dimensions

### 1. Response Efficiency

From message timestamps and metadata:
- **Response latency**: Time between user message and agent response
- **Tokens per task**: Input/output tokens consumed for task completion
- **Cost efficiency**: Cost in USD per completed task

Look for metadata fields in log entries:
```
elapsedMs, costUsd, inputTokens, outputTokens
```

### 2. Task Completion

From conversation flow analysis:
- **Completion rate**: Tasks that reached a successful conclusion
- **Iteration count**: Number of back-and-forth rounds needed
- **Abandonment rate**: Tasks where user gave up or switched topic

Indicators of completion:
- User expresses satisfaction ("thanks", "完美", "解决了", "good")
- Final result delivered (code written, PR created, answer given)
- No follow-up corrections needed

Indicators of failure:
- User repeats the same request
- User corrects agent output multiple times
- Conversation ends without resolution
- Error messages in tool output

### 3. Tool Usage Efficiency

From tool invocation patterns:
- **Tool calls per task**: Average number of tool invocations
- **Tool success rate**: Percentage of successful tool executions
- **Tool selection accuracy**: Whether the right tools were chosen for the task

Look for metadata field: `toolName`

### 4. User Feedback Signals

From user message sentiment analysis:
- **Positive signals**: "thanks", "完美", "厉害", "很好", "excellent", "great"
- **Negative signals**: "不对", "错了", "not what I asked", "try again", "不满意"
- **Neutral/ambivalent**: No clear feedback, topic change

### 5. Error Patterns

From error messages in logs:
- **Frequency**: How often errors occur
- **Type**: Tool errors, API errors, timeout errors, format errors
- **Recovery**: Whether the agent successfully recovered

Look for patterns: "Error", "failed", "失败", "错误", "timeout", "超时"

---

## Analysis Process

### Step 1: Collect Chat Logs

```
Use Glob to find log files: workspace/logs/**/*.md
```

Also check alternative paths:
```
workspace/chat/*.md
```

**Focus on recent logs** (last 7 days for weekly, 30 days for monthly reports).

### Step 2: Extract Per-Session Metrics

For each chat session (chatId + date), extract:

| Metric | Source | How to Extract |
|--------|--------|---------------|
| Model/Provider | Log header or config | Look for model name in system messages |
| Tasks attempted | User messages | Count distinct user requests |
| Tasks completed | Conversation flow | Check for satisfaction signals |
| Avg response time | Timestamps | Calculate deltas between messages |
| Total tokens | metadata fields | Sum inputTokens + outputTokens |
| Total cost | metadata fields | Sum costUsd |
| Tool calls | metadata fields | Count toolName occurrences |
| Errors | Content scan | Count error-related messages |

### Step 3: Aggregate by Framework/Model

Group sessions by:
- **Agent type**: Schedule agent, skill agent, chat agent, etc.
- **Model**: claude-sonnet, claude-opus, etc. (if visible in logs)
- **Task type**: coding, analysis, chat, management

Calculate aggregate statistics per group:
- Mean/median response time
- Task completion rate (%)
- Mean cost per task
- Mean tool calls per task
- Error rate (%)

### Step 4: Identify Unique Characteristics

Beyond quantitative metrics, identify **qualitative differences** that can't be measured in a horse race:

- **Creative problem-solving**: Novel approaches to complex tasks
- **Context awareness**: Understanding of project-specific conventions
- **Communication style**: How well the agent explains its actions
- **Proactive behavior**: Whether the agent anticipates needs

These qualitative insights are where the LLM's analysis adds the most value.

### Step 5: Generate Report

Create a structured benchmark report:

```markdown
## Agent Framework Benchmark Report

**Report Period**: [Date range]
**Analysis Scope**: [Number of chat sessions analyzed]

---

### Summary

| Framework/Model | Sessions | Completion Rate | Avg Cost/Task | Error Rate | Rating |
|-----------------|----------|-----------------|---------------|------------|--------|
| [Framework A]   | X        | X%              | $X.XX         | X%         | ⭐⭐⭐⭐⭐ |
| [Framework B]   | X        | X%              | $X.XX         | X%         | ⭐⭐⭐⭐ |

---

### Performance Details

#### [Framework/Model Name]

**Strengths**:
- [Specific strength with example]

**Weaknesses**:
- [Specific weakness with example]

**Unique Characteristics**:
- [Qualitative insight that differentiates this framework]

---

### Recommendations

1. **Best for [Task Type]**: [Framework] — [Reasoning]
2. **Best for [Task Type]**: [Framework] — [Reasoning]
3. **Cost Optimization**: [Suggestion]
4. **Quality Improvement**: [Suggestion]

---

### Methodology Notes

- Data source: workspace/logs/ chat histories
- Sample size: X sessions, Y messages
- Analysis period: [Date range]
- Limitations: [Any caveats about the data]
```

### Step 6: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Data Extraction Tips

### Identifying Agent Type from Logs

Look for these patterns in log file paths and content:
- **Schedule Agent**: Logs under scheduled task execution context
- **Skill Agent**: Logs referencing skill invocations
- **Chat Agent**: Regular chat conversation logs

### Identifying Model from Logs

Check for:
- System messages mentioning model name
- Configuration headers in log files
- Metadata containing model identifiers

### Handling Incomplete Data

If metadata fields are missing:
- Estimate response time from message timestamps
- Skip cost/token metrics if not available
- Note the limitation in the methodology section

---

## Report Variants

### Weekly Report (Default)

- Period: Last 7 days
- Focus: Recent trends and anomalies
- Level: Summary with key highlights

### Monthly Deep Dive

- Period: Last 30 days
- Focus: Comprehensive analysis with statistical rigor
- Level: Detailed metrics and trend analysis

### On-Demand Comparison

- Period: User-specified
- Focus: Specific frameworks or task types
- Level: Targeted analysis per user request

---

## DO NOT

- Modify any agent code or configuration
- Add logging or metrics collection to the codebase
- Create new scheduled tasks during analysis
- Send reports to wrong chatId
- Include sensitive user data (API keys, personal info) in reports
- Make claims without evidence from the chat logs
- Fabricate metrics if data is insufficient — note limitations instead

---

## Example Output

```markdown
## Agent Framework Benchmark Report

**Report Period**: 2026-04-18 ~ 2026-04-25
**Analysis Scope**: 12 chat sessions, 847 messages

---

### Summary

| Framework/Model | Sessions | Completion Rate | Avg Cost/Task | Error Rate | Rating |
|-----------------|----------|-----------------|---------------|------------|--------|
| Schedule Agent  | 5        | 80%             | $0.12         | 5%         | ⭐⭐⭐⭐ |
| Skill Agent     | 4        | 75%             | $0.08         | 8%         | ⭐⭐⭐⭐ |
| Chat Agent      | 3        | 90%             | $0.15         | 2%         | ⭐⭐⭐⭐⭐ |

---

### Unique Characteristics

**Schedule Agent**: Excels at routine, well-defined tasks. Consistent execution patterns. Limited adaptability to unexpected situations.

**Skill Agent**: Good at domain-specific tasks. More creative problem-solving within its domain. Can be brittle when tasks cross domain boundaries.

**Chat Agent**: Best at open-ended conversations and complex multi-step tasks. Highest context awareness. Higher cost per task but best completion rate.

---

### Recommendations

1. **Routine Tasks**: Schedule Agent — Most cost-efficient for predictable operations
2. **Complex Tasks**: Chat Agent — Highest completion rate despite higher cost
3. **Cost Optimization**: Review Skill Agent error patterns — 8% error rate suggests room for improvement
4. **Quality Focus**: Investigate Schedule Agent failures — 20% incomplete rate warrants attention
```
