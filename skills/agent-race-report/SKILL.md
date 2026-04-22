---
name: agent-race-report
description: Agent performance analysis specialist - analyzes chat logs to evaluate and compare agent/framework performance. Generates structured reports covering response efficiency, task completion, user satisfaction, tool usage, and error patterns. Use for agent quality evaluation tasks, or when user says keywords like "赛马", "Agent评估", "框架对比", "agent race", "performance report".
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Agent Race Report

Analyze chat histories to evaluate and compare agent/framework performance across different dimensions, generating structured quality reports.

## When to Use This Skill

**Use this skill for:**
- Periodic agent performance evaluation
- Comparing different models/providers on real-world tasks
- Identifying quality issues and improvement opportunities
- Generating weekly/monthly performance reports

**Keywords that trigger this skill**: "赛马", "Agent评估", "框架对比", "agent race", "performance report", "服务质量", "agent performance"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based analysis on real chat logs to evaluate agent performance.**

No code changes to the agent framework. No embedded metrics collection. The LLM analyzes conversation patterns directly from chat history logs, identifying performance differences between models, providers, and agent types.

---

## Analysis Process

### Step 1: Read Chat Logs

Read all chat log files from the logs directory:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-04-15.md
│   └── 2026-04-16.md
├── oc_chat2/
│   └── 2026-04-16.md
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Read each log file with `Read` tool
3. Focus on recent logs (last 7 days for weekly report, last 30 days for monthly)

### Step 2: Identify Agent Interactions

For each chat log, identify distinct agent interactions (conversations):

An agent interaction is a complete exchange:
- **User message** → The task/request
- **Agent response(s)** → The work done
- **Outcome** → User satisfaction, task completion signal

Look for these patterns to distinguish interactions:
- Timestamps indicating new conversation starts (gap > 30 minutes)
- User messages that start new tasks
- Agent responses with tool calls and results

### Step 3: Evaluate Performance Dimensions

Analyze each interaction across these 5 dimensions:

#### 1. Response Efficiency (响应效率)
- **Time to first response**: How quickly the agent starts responding
- **Total resolution time**: How long from user request to task completion
- **Message round trips**: How many back-and-forth exchanges needed

**Rating criteria:**
- ⭐⭐⭐: Task completed in first response
- ⭐⭐: Task completed in 2-3 exchanges
- ⭐: Required 4+ exchanges

#### 2. Task Completion (任务完成度)
- **Fully completed**: User's request was satisfied without follow-up corrections
- **Partially completed**: Some aspects addressed, others missed
- **Failed**: Agent could not complete the task

**Indicators of completion:**
- User says "thanks", "done", "good" (positive signal)
- User does NOT repeat or rephrase the same request
- Agent explicitly states task completion

**Indicators of failure:**
- User repeats the same request differently
- User says "not right", "still broken", "try again"
- Agent hits errors or timeouts

#### 3. User Satisfaction (用户满意度)
- **Positive signals**: "thanks", "perfect", "great", thumbs up, no follow-up correction
- **Neutral signals**: Task completed but no explicit feedback
- **Negative signals**: "wrong", "not what I wanted", repeated corrections, user gives up

**Corrections to track:**
- "应该是..." / "改成..." / "不对..." → Agent made an error
- "帮我改成..." / "我要的是..." → Misunderstood request
- Multiple correction rounds → Persistent issues

#### 4. Tool Usage Efficiency (工具使用效率)
- **Efficient**: Right tools used, minimal unnecessary calls
- **Moderate**: Some redundant tool calls, but task completed
- **Inefficient**: Excessive tool calls, wrong tools, retries

**Patterns to detect:**
- Repeated failed tool calls (same tool, same parameters)
- Unnecessary exploration before action
- Optimal tool selection for the task type

#### 5. Error Patterns (错误模式)
- **Type errors**: Code compilation failures
- **Logic errors**: Wrong output, incorrect reasoning
- **Tool errors**: MCP tool failures, API errors
- **Timeout errors**: Task exceeded time limits

### Step 4: Aggregate by Agent/Model/Provider

Group interactions by identifiable agent characteristics:

```
Grouping levels (use what's available):
├── By model: claude-sonnet, gpt-4o, etc.
├── By provider: anthropic, openai, etc.
├── By agent type: skillAgent, scheduleAgent, etc.
└── By task type: coding, analysis, creative, qa
```

If model/provider information is not directly in the logs, group by chat or time period and note that differentiation was not possible.

### Step 5: Generate Report

Create a structured performance report:

```markdown
## 🏁 Agent 性能评估报告

**分析时间**: [Timestamp]
**分析范围**: [Last 7 days / Last 30 days]
**评估交互数**: [Number of interactions analyzed]
**覆盖聊天数**: [Number of chats covered]

---

### 📊 总体概览

| 维度 | 评分 | 趋势 |
|------|------|------|
| 响应效率 | ⭐⭐⭐ (3.8/5) | ➡️ 稳定 |
| 任务完成度 | ⭐⭐⭐⭐ (4.2/5) | ⬆️ 提升 |
| 用户满意度 | ⭐⭐⭐ (3.5/5) | ⬇️ 下降 |
| 工具效率 | ⭐⭐⭐⭐ (4.0/5) | ➡️ 稳定 |
| 错误率 | 8.3% | ⬇️ 改善 |

---

### 🏆 表现最佳

**交互 #{id}**: [Task description]
- **亮点**: One-shot completion, zero corrections
- **耗时**: [Time]
- **用户反馈**: "完美，正是我要的"

### ⚠️ 需要改进

**交互 #{id}**: [Task description]
- **问题**: Required 5 rounds of corrections
- **根因**: Misunderstood initial request, over-complicated solution
- **建议**: Better initial clarification before implementation

---

### 📈 趋势分析

[Compare with previous report if available]
- 任务完成率: 85% → 88% (+3%)
- 平均交互轮次: 2.3 → 2.1 (-0.2)
- 用户纠正次数: 12 → 8 (-33%)

---

### 🔍 详细发现

#### 优势
1. [Specific strength with example]
2. [Another strength]

#### 待改进
1. [Specific issue with example]
2. [Another issue]

#### 错误模式
| 错误类型 | 出现次数 | 典型场景 |
|----------|----------|----------|
| [Type] | [Count] | [Example] |

---

### 📋 改进建议

1. **[High Priority]** [Specific recommendation]
2. **[Medium Priority]** [Specific recommendation]
3. **[Low Priority]** [Observation/suggestion]
```

### Step 6: Send Report

**CRITICAL**: Always send the report to the user using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Analysis Guidelines

### What to Focus On

| Dimension | Key Indicators | Weight |
|-----------|---------------|--------|
| Task Completion | Request fulfilled without re-asking | 30% |
| User Satisfaction | Explicit positive/negative signals | 25% |
| Response Efficiency | Time and round trips to completion | 20% |
| Tool Usage | Appropriate tool selection and calls | 15% |
| Error Rate | Failures, retries, corrections needed | 10% |

### What to Ignore

- Test/debug messages
- System notifications
- One-off edge cases without pattern
- Issues clearly caused by external factors (network, API outages)

### What Makes a Good Report

1. **Specific examples** — Include actual quotes from chat logs
2. **Actionable recommendations** — Not just "do better" but "when user says X, first clarify Y"
3. **Trend comparison** — Compare with previous report if available at `workspace/data/race-report-history.json`
4. **Balanced view** — Highlight strengths alongside weaknesses

---

## Data Persistence

After generating the report, save analysis results for trend tracking:

**File**: `workspace/data/race-report-history.json`

```json
{
  "reports": [
    {
      "date": "2026-04-22T09:00:00.000Z",
      "chatId": "oc_xxx",
      "period": "7d",
      "interactionsAnalyzed": 42,
      "overallScore": 3.8,
      "taskCompletionRate": 0.88,
      "avgRoundsToComplete": 2.1,
      "userCorrectionCount": 8,
      "errorRate": 0.083,
      "topIssues": ["Misunderstood requirements", "Over-complicated solutions"],
      "topStrengths": ["One-shot coding tasks", "Clear explanations"]
    }
  ]
}
```

This allows future reports to show trends by comparing with historical data.

---

## Schedule Integration

This skill can be invoked by a scheduled task. Example schedule configuration:

```yaml
schedules:
  - name: "weekly-agent-race-report"
    cron: "0 9 * * 1"  # Every Monday 9:00
    prompt: "执行 Agent 性能评估：分析过去一周的聊天记录，评估 Agent 服务质量，生成周报"
```

---

## DO NOT

- Modify any core agent code
- Add logging or metrics collection to the codebase
- Create new modules or packages
- Compare models/providers if information is not available in logs
- Send reports to wrong chatId
- Include sensitive user information in reports
- Make assumptions about user intent
- Skip the send_user_feedback step

## Checklist

- [ ] Read all chat log files from workspace/logs/
- [ ] Identified distinct agent interactions
- [ ] Evaluated across all 5 dimensions
- [ ] Generated structured report with specific examples
- [ ] Saved analysis results to race-report-history.json
- [ ] **Sent report via send_user_feedback** (CRITICAL)
