---
name: agent-race-review
description: Agent performance comparison specialist - analyzes chat logs to compare and evaluate different agent frameworks/models. Use for agent quality assessment, model comparison, performance benchmarking, or when user says keywords like "赛马", "Agent比较", "模型对比", "性能评估", "agent race", "performance review", "framework comparison". Triggered by scheduler for periodic automated analysis.
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Agent Race Review

Analyze chat histories to compare and evaluate different agent frameworks/models based on real interaction quality.

## When to Use This Skill

**Use this skill for:**
- Comparing agent performance across different models/providers
- Evaluating agent quality based on real user interactions
- Generating periodic agent benchmark reports
- Identifying strengths and unique characteristics of each agent

**Keywords that trigger this skill**: "赛马", "Agent比较", "模型对比", "性能评估", "agent race", "performance review", "framework comparison", "benchmark"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based analysis on chat logs to evaluate agent performance. No code changes to core modules.**

This skill analyzes existing chat history to derive quality metrics. It does NOT inject instrumentation or modify agent behavior.

---

## Analysis Process

### Step 1: Read Chat Logs

Read all chat log files from the logs directory:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-04-01.md
│   ├── 2026-04-02.md
│   └── ...
├── oc_chat2/
│   └── ...
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Focus on recent logs (last 7 days for daily review, last 30 days for weekly/monthly)
3. Read each log file with `Read` tool

### Step 2: Identify Agent Interactions

For each chat log, identify and categorize agent interactions:

1. **Agent Type Detection**
   - Identify which agent/model handled each interaction
   - Look for metadata in messages: model names, provider info, skill names
   - Categorize by: model type (e.g., Claude Sonnet, Claude Opus), task type (coding, research, chat), skill used

2. **Task Outcome Assessment**
   - **Successful**: Task completed, user satisfied, no follow-up corrections needed
   - **Partial**: Task partially completed, some corrections needed
   - **Failed**: Task not completed, errors, user had to retry or switch approach
   - **Abandoned**: User gave up or changed topic without resolution

3. **Efficiency Indicators**
   - Number of turns to complete a task
   - Whether tools were used effectively
   - Whether the agent asked clarifying questions vs. guessing

### Step 3: Evaluate Performance Dimensions

Analyze each identified agent/model across these dimensions:

| Dimension | Indicators | Weight |
|-----------|-----------|--------|
| **Task Completion** | Success rate, first-attempt resolution | High |
| **Efficiency** | Turns to completion, tool usage effectiveness | Medium |
| **Accuracy** | User corrections, retry frequency | High |
| **User Satisfaction** | Thank/follow-up patterns, repeated requests | Medium |
| **Unique Strengths** | Distinctive capabilities not covered by metrics | Low |

### Step 4: Generate Comparison Report

Create a structured analysis report:

```markdown
## 🏁 Agent Performance Comparison Report

**Analysis Period**: [Date range]
**Total Interactions Analyzed**: [Number]
**Agents Compared**: [List of agents/models]

---

### 📊 Performance Summary

| Agent/Model | Interactions | Success Rate | Avg Turns | Corrections |
|-------------|-------------|-------------|-----------|-------------|
| [Agent A] | X | X% | X.X | X |
| [Agent B] | X | X% | X.X | X |

---

### 🏆 Strengths by Agent

#### [Agent A]
- **Strengths**: [What this agent does well]
- **Weaknesses**: [Where it struggles]
- **Best For**: [Task types where it excels]

#### [Agent B]
- **Strengths**: ...
- **Weaknesses**: ...
- **Best For**: ...

---

### 🎯 Task Type Analysis

| Task Type | Best Agent | Success Rate | Notes |
|-----------|-----------|-------------|-------|
| Coding | [Agent] | X% | ... |
| Research | [Agent] | X% | ... |
| Chat/Q&A | [Agent] | X% | ... |

---

### ✨ Unique Characteristics

Features that cannot be directly compared but are noteworthy:

- [Agent A]: [Unique capability or behavior]
- [Agent B]: [Unique capability or behavior]

---

### 📋 Recommendations

1. **Optimal Assignment**: [Which agent for which task type]
2. **Improvement Areas**: [Where agents need improvement]
3. **Configuration Suggestions**: [Any settings adjustments]
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

### What to Compare

- **Same task, different agents**: When different models handle similar tasks, compare outcomes directly
- **Task-specific performance**: Some agents may excel at coding but struggle at research
- **Qualitative differences**: Nuanced capabilities that metrics can't capture

### What to Look For

| Signal | Positive Indicator | Negative Indicator |
|--------|-------------------|-------------------|
| User corrections | None or minor | Frequent "不对", "应该是" |
| Task completion | "谢谢", "完成了" | "算了", "我自己来" |
| Efficiency | Single-turn resolution | Multiple retries needed |
| Tool usage | Appropriate tools selected | Wrong tools or missing tools |
| Understanding | Follows instructions precisely | Misinterprets or ignores constraints |

### What to Ignore

- Test/debug messages
- Intentional experiments
- Context-specific failures (e.g., API outage)
- Single outlier interactions
- Personal preferences without objective basis

---

## Report Quality Checklist

- [ ] Read all relevant chat log files
- [ ] Identified agent/model for each interaction
- [ ] Assessed task outcomes (success/partial/fail/abandoned)
- [ ] Compared performance across dimensions
- [ ] Noted unique characteristics that can't be ranked
- [ ] Generated structured comparison report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core agent code or add instrumentation
- Create new modules or execution engines
- Make conclusions based on a single interaction
- Ignore qualitative differences between agents
- Rank agents without sufficient data (flag as "insufficient data")
- Send reports to wrong chatId
- Include sensitive user information in reports
