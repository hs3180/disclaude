---
name: agent-race
description: Agent Framework performance analysis specialist - analyzes chat logs to evaluate and compare agent/framework performance across providers and models. Use for agent benchmarking, performance review, or when user says keywords like "赛马", "框架对比", "性能分析", "agent race", "framework benchmark", "质量评估". Triggered by scheduler for periodic automated execution.
allowed-tools: Read, Glob, Grep, Bash
---

# Agent Race — Framework Performance Analysis

Analyze chat logs to evaluate and compare agent/framework performance across different providers, models, and task types.

## When to Use This Skill

**Use this skill for:**
- Periodic agent performance review (daily/weekly)
- Comparing different models/providers on task quality
- Identifying which agent configurations work best for specific task types
- Detecting performance regressions over time
- Evaluating cost-efficiency across providers

**Keywords that trigger this skill**: "赛马", "框架对比", "性能分析", "agent race", "framework benchmark", "质量评估", "agent performance"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

---

## Core Principle

**Zero code invasion — pure log analysis.**

This skill does NOT modify any core code. It reads existing chat logs and derives performance metrics through LLM-based analysis of message patterns, timestamps, and conversation outcomes.

---

## Analysis Dimensions

### 1. Response Efficiency
- **First response time**: Time from user message to first agent reply
- **Total response time**: Time from user message to task completion
- **Turns to completion**: Number of back-and-forth exchanges needed

### 2. Task Completion Quality
- **Completion rate**: Ratio of tasks successfully completed vs abandoned
- **User satisfaction signals**: Thank-you messages, corrections, complaints
- **Retry rate**: How often the user asks the agent to redo/fix something

### 3. Error Patterns
- **Tool call failures**: Tool errors, permission issues
- **Retry loops**: Agent retrying the same failing operation
- **Abandoned tasks**: Tasks where the user gave up

### 4. Cost Efficiency (when available)
- **Token usage patterns**: Input/output token ratios
- **Tool call frequency**: Number of tool calls per task
- **Cost per successful task**: Estimated cost based on token usage

---

## Analysis Process

### Step 1: Read Chat Logs

Read chat log files from the logs directory:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-04-14.md
│   ├── 2026-04-15.md
│   └── ...
├── oc_chat2/
│   └── ...
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Focus on the analysis period (last 7 days by default, or as specified by user)
3. Read each log file with `Read` tool

### Step 2: Extract Per-Conversation Metrics

For each conversation, extract:

```yaml
conversation_id: "oc_xxx"
date: "2026-04-15"
provider: "anthropic"  # or "glm", inferred from response style/patterns
model: "claude-sonnet"  # inferred from behavior, or from explicit mentions
tasks:
  - task_type: "coding"       # coding, analysis, research, discussion, qa
    description: "Fix bug in auth module"
    start_time: "2026-04-15T09:15:00Z"
    first_response: "2026-04-15T09:15:05Z"
    end_time: "2026-04-15T09:18:30Z"
    turns: 4
    outcome: "completed"       # completed, partially_completed, abandoned, errored
    corrections: 1             # number of user corrections
    tool_calls: 3
    errors: 0
```

### Step 3: Aggregate and Compare

Group metrics by dimensions:

1. **By Provider/Model**: Compare different model configurations
2. **By Task Type**: Which models excel at which tasks
3. **By Time Period**: Performance trends over time
4. **By Chat Context**: Group chat vs direct chat performance

### Step 4: Generate Report

Create a structured comparison report:

```markdown
## 🏁 Agent Framework Performance Report

**Analysis Period**: [Date range]
**Conversations Analyzed**: [Count]
**Tasks Identified**: [Count]

---

### 📊 Overall Performance Summary

| Provider/Model | Tasks | Completed | Abandoned | Avg Turns | Avg Duration | Corrections |
|----------------|-------|-----------|-----------|-----------|-------------|-------------|
| anthropic/claude-sonnet | 12 | 10 (83%) | 2 | 3.2 | 4m 30s | 0.8 |
| glm/glm-5 | 5 | 3 (60%) | 2 | 5.1 | 8m 15s | 2.4 |

---

### 🏆 Strengths by Task Type

#### Coding Tasks
| Provider/Model | Success Rate | Avg Turns | Notes |
|----------------|-------------|-----------|-------|
| claude-sonnet | 90% | 2.8 | Excellent at complex refactors |
| glm-5 | 50% | 5.2 | Struggles with TypeScript |

#### Analysis & Research
| Provider/Model | Success Rate | Avg Turns | Notes |
|----------------|-------------|-----------|-------|
| claude-sonnet | 85% | 3.5 | Deep analysis, good follow-up |
| glm-5 | 80% | 3.8 | Adequate for simple lookups |

---

### 📉 Error Patterns

| Error Type | Provider | Frequency | Example |
|------------|----------|-----------|---------|
| Tool call timeout | claude-sonnet | 2/week | Long file reads |
| Syntax error in output | glm-5 | 3/week | Python indentation |

---

### 💡 Insights

1. **Best for coding**: claude-sonnet (90% success, fewest corrections)
2. **Best for research**: [analysis based on data]
3. **Cost efficiency**: [analysis based on turns/tokens]
4. **Unique strengths**:
   - claude-sonnet: Complex multi-file refactoring
   - glm-5: [unique strengths if any]

---

### 📋 Recommendations

1. **Route coding tasks to**: claude-sonnet
2. **Route research tasks to**: [based on data]
3. **Watch for**: [emerging patterns or regressions]
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

## Metric Extraction Guidelines

### Inferring Provider/Model

Chat logs may not explicitly state the provider. Use these signals:

| Signal | Indicates |
|--------|-----------|
| "Claude", "Anthropic" mentions | anthropic provider |
| "GLM", "Zhipu" mentions | glm provider |
| Response style (detailed explanations) | Likely claude-sonnet |
| Response style (concise, less tool use) | Likely glm or smaller model |
| Explicit model mentions in logs | Direct identifier |

### Determining Task Outcome

| Pattern | Outcome |
|---------|---------|
| User says "谢谢", "完成了", "好了" | completed |
| User says "不对", "重做", "还是不行" | partially_completed (needs retry) |
| User stops responding after error | abandoned |
| Error messages in log | errored |
| No final resolution visible | unknown |

### Counting Corrections

A "correction" is when the user provides feedback indicating the agent's output was wrong:
- "不对，应该是..."
- "不是这个，我要的是..."
- "改一下..."
- "重新来"

---

## Scheduling Configuration

This skill is designed to be run as a scheduled task:

```yaml
# Weekly performance review
schedules:
  - name: "weekly-agent-race"
    cron: "0 10 * * 1"  # Every Monday 10:00
    prompt: "/agent-race 分析过去一周的 Agent 执行表现，生成框架赛马周报"
    chatId: "oc_admin_chat"

# Daily quick review
schedules:
  - name: "daily-agent-race"
    cron: "0 22 * * *"  # Every day 22:00
    prompt: "/agent-race 分析今天的 Agent 执行表现，重点关注异常和退步"
    chatId: "oc_admin_chat"
```

---

## Important Notes

- This is a **read-only analysis** skill — it does NOT modify any code or configuration
- Performance metrics are **approximations** derived from chat patterns, not exact measurements
- The analysis quality depends on the detail level of available chat logs
- When insufficient data exists, clearly state the limitation in the report
- Focus on **actionable insights**, not just raw numbers
- Highlight **unique strengths** that cannot be captured by metrics alone

---

## Checklist

- [ ] Read chat log files from workspace/logs/
- [ ] Extract per-conversation metrics (response time, turns, outcomes)
- [ ] Group by provider/model and task type
- [ ] Identify error patterns and correction rates
- [ ] Generated structured comparison report
- [ ] Highlight unique strengths per provider
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core agent code
- Introduce new logging statements in the codebase
- Create hard-coded scoring or ranking algorithms
- Make conclusions without sufficient data
- Skip the send_user_feedback step
- Compare only on metrics — always include qualitative analysis
