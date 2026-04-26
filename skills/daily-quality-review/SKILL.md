---
name: daily-quality-review
description: Daily Agent quality analysis specialist - analyzes chat history to evaluate and compare Agent framework performance across multiple dimensions. Use for quality assessment tasks, agent performance comparison, or when user says keywords like "质量评估", "Agent评估", "服务评价", "quality review", "agent comparison", "赛马报告".
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Daily Quality Review

Analyze chat history to evaluate Agent service quality across multiple dimensions and generate comparison reports.

## When to Use This Skill

**Use this skill for:**
- Periodic Agent service quality assessment
- Comparing Agent performance across different chats/time periods
- Identifying systemic quality issues
- Generating data-driven improvement recommendations
- Triggered by scheduler for automated weekly execution

**Keywords that trigger this skill**: "质量评估", "Agent评估", "服务评价", "quality review", "agent comparison", "赛马报告", "agent benchmark"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero code intrusion — use LLM-based analysis of existing chat history.**

This skill does NOT instrument the Agent framework or modify any core code. Instead, it leverages the LLM's ability to analyze natural language chat logs and extract quality signals from real user interactions.

---

## Quality Evaluation Dimensions

### 1. Response Efficiency (响应效率)

**What to measure**: How quickly and efficiently the Agent responds to user requests.

**Indicators in chat logs**:
- Message timestamps between user request and Agent response
- Number of conversation turns needed to complete a task
- Whether the Agent proactively provides complete answers vs. requiring follow-up questions

**Scoring criteria**:
| Rating | Description |
|--------|-------------|
| ⭐⭐⭐ | Task completed in 1-2 turns, minimal follow-up needed |
| ⭐⭐ | Task completed in 3-5 turns, some clarification needed |
| ⭐ | Task required many turns or significant user guidance |

### 2. Task Completion (任务完成度)

**What to measure**: Whether and how well the Agent completes requested tasks.

**Indicators in chat logs**:
- Whether the conversation ends with a clear resolution
- User follow-up indicating dissatisfaction ("不对", "还是没有解决", "算了")
- Tasks that were abandoned without completion
- Whether the Agent followed user requirements accurately

**Scoring criteria**:
| Rating | Description |
|--------|-------------|
| ⭐⭐⭐ | Task fully completed, user satisfied |
| ⭐⭐ | Task mostly completed, minor issues |
| ⭐ | Task incomplete or user gave up |

### 3. User Satisfaction (用户满意度)

**What to measure**: How users feel about the Agent's service quality.

**Indicators in chat logs**:
- Positive signals: "谢谢", "好的", "很好", "赞", thumbs up
- Negative signals: "不对", "错了", "应该是", "改一下", repeated corrections
- Frustration signals: "又来了", "怎么还是不行", "算了我自己来"
- Trust signals: User follows Agent's recommendations without questioning

**Scoring criteria**:
| Rating | Description |
|--------|-------------|
| ⭐⭐⭐ | Mostly positive, user trusts and follows recommendations |
| ⭐⭐ | Mixed, some corrections but overall functional |
| ⭐ | Frequent corrections, user frustration evident |

### 4. Tool Usage Efficiency (工具使用效率)

**What to measure**: How effectively the Agent uses available tools.

**Indicators in chat logs**:
- Number of tool calls relative to task complexity
- Whether tool calls produced useful results
- Redundant or unnecessary tool calls
- Appropriate tool selection for the task at hand

**Scoring criteria**:
| Rating | Description |
|--------|-------------|
| ⭐⭐⭐ | Minimal tool calls, each producing useful results |
| ⭐⭐ | Reasonable tool usage, some redundancy |
| ⭐ | Excessive tool calls or poor tool selection |

### 5. Error Rate (错误率)

**What to measure**: How often the Agent makes mistakes.

**Indicators in chat logs**:
- Error messages in Agent responses ("失败", "错误", "无法完成")
- Tasks that required retries or restarts
- Agent self-corrections ("抱歉", "让我重新")
- User-reported errors

**Scoring criteria**:
| Rating | Description |
|--------|-------------|
| ⭐⭐⭐ | No errors or rare, quickly self-corrected |
| ⭐⭐ | Some errors, usually recoverable |
| ⭐ | Frequent errors, significantly impacting tasks |

---

## Analysis Process

### Step 1: Read All Chat Logs

Read all chat log files from the logs directory:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-04-19.md
│   ├── 2026-04-20.md
│   └── ...
├── oc_chat2/
│   └── 2026-04-20.md
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Read each log file with `Read` tool
3. Focus on recent logs (last 7 days recommended)

### Step 2: Analyze Each Chat Session

For each chat session, evaluate the five quality dimensions:

1. **Response Efficiency**: Count conversation turns per task. Look for patterns where the Agent needed excessive clarification.

2. **Task Completion**: Track whether each task reached a satisfactory conclusion. Note tasks that were abandoned.

3. **User Satisfaction**: Identify positive and negative signals. Count user corrections per conversation.

4. **Tool Usage**: Note tool call patterns. Identify redundant or unnecessary calls.

5. **Error Rate**: Count error occurrences. Note whether errors were self-corrected.

### Step 3: Aggregate and Compare

Aggregate findings across all chats:

1. **Overall Quality Score**: Average across all dimensions
2. **Dimension Breakdown**: Scores for each dimension
3. **Trend Analysis**: Compare with previous period if data available
4. **Top Issues**: Most frequently occurring quality problems

### Step 4: Generate Report

Create a structured quality assessment report:

```markdown
## 📊 Agent 服务质量评估报告

**评估周期**: [Start Date] ~ [End Date]
**分析聊天数**: [Number of chats]
**总消息数**: [Total messages]
**评估维度**: 5

---

### 📈 综合质量评分

| 维度 | 评分 | 趋势 |
|------|------|------|
| 响应效率 | ⭐⭐⭐ (3/3) | — |
| 任务完成度 | ⭐⭐ (2/3) | — |
| 用户满意度 | ⭐⭐ (2/3) | — |
| 工具使用效率 | ⭐⭐⭐ (3/3) | — |
| 错误率 | ⭐⭐⭐ (3/3) | — |
| **综合** | **⭐⭐½ (2.6/3)** | — |

---

### 🔍 详细分析

#### 响应效率
- **平均对话轮次/任务**: X 轮
- **主要发现**: [发现描述]
- **典型案例**:
  > [引用聊天记录中的典型场景]

#### 任务完成度
- **完成率**: X%
- **放弃率**: X%
- **主要发现**: [发现描述]
- **未完成原因**: [分类列举]

#### 用户满意度
- **正面信号**: X 次
- **负面信号**: X 次
- **纠正次数**: X 次
- **主要发现**: [发现描述]

#### 工具使用效率
- **平均工具调用/任务**: X 次
- **主要发现**: [发现描述]

#### 错误率
- **错误次数**: X 次
- **自修复次数**: X 次
- **主要发现**: [发现描述]

---

### 🔴 需要关注的问题

#### 问题 1: [Issue Title]
- **维度**: [Related dimension]
- **出现频率**: X 次
- **涉及聊天**: [Chat IDs]
- **典型场景**:
  > [Quote from chat]

- **建议改进**: [Improvement suggestion]

---

### 🟡 改进建议

1. **[Suggestion 1]**: [Description and expected benefit]
2. **[Suggestion 2]**: [Description and expected benefit]

---

### ✅ 表现良好的方面

- [Things working well based on analysis]

---

### 📋 总结

[Overall summary and key takeaways]
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

### What to Include

| Category | Indicators | Weight |
|----------|------------|--------|
| Response Efficiency | Turn count, follow-up frequency | 20% |
| Task Completion | Resolution rate, abandonment | 25% |
| User Satisfaction | Positive/negative signals, corrections | 25% |
| Tool Usage | Efficiency, appropriateness | 15% |
| Error Rate | Frequency, recovery rate | 15% |

### What to Ignore

- Test/debug messages
- System notifications
- Very short conversations (< 3 messages)
- Off-topic conversations
- One-time anomalies without pattern

### Scoring Rules

1. Score each dimension independently (1-3 stars)
2. Weight the overall score according to the table above
3. Only count patterns with 2+ occurrences as significant
4. Consider conversation context when interpreting signals
5. A user correction that leads to immediate improvement is less severe than repeated corrections for the same issue

---

## Example Analysis

### Input (Chat History Excerpt):

```
## [2026-04-20T09:15:00Z] 📥 User
帮我分析一下这个 PR 的代码质量

## [2026-04-20T09:15:30Z] 📤 Bot
好的，让我查看这个 PR 的代码...
[Uses Read tool to view PR files]
分析完成。这个 PR 有以下几个问题：
1. ...

## [2026-04-20T09:18:00Z] 📥 User
不对，你漏看了 tests 目录下的文件

## [2026-04-20T09:18:15Z] 📤 Bot
抱歉，让我补充查看 tests 目录...
[Uses Read tool again]
补充分析：测试文件中...

## [2026-04-20T09:20:00Z] 📥 User
好的，谢谢
```

### Analysis:

| Dimension | Assessment | Reasoning |
|-----------|------------|-----------|
| Response Efficiency | ⭐⭐ | Needed 2 turns instead of 1; missed part of scope |
| Task Completion | ⭐⭐⭐ | Eventually completed after correction |
| User Satisfaction | ⭐⭐ | One correction needed, but user satisfied at end |
| Tool Usage | ⭐⭐ | Should have read tests directory in first pass |
| Error Rate | ⭐⭐⭐ | One omission, quickly corrected |

---

## Integration with Other Systems

### Current Phase: Report Only
- Analyze chat history
- Generate quality assessment report
- Send via `send_user_feedback`

### Future Phase: Trend Tracking
- Store weekly scores for trend comparison
- Identify improving or declining quality areas
- Correlate quality changes with code/config changes

### Future Phase: Automated Actions
- Create issues for persistent quality problems
- Recommend skill/schedule optimizations
- Trigger alerts for quality degradation

---

## Checklist

- [ ] Read all chat log files from workspace/logs/
- [ ] Analyzed each chat across all 5 quality dimensions
- [ ] Scored each dimension with supporting evidence
- [ ] Aggregated findings across all chats
- [ ] Generated structured quality assessment report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core Agent code (BaseAgent, providers, etc.)
- Create new modules in packages/core/
- Add instrumentation or metrics collection to the Agent framework
- Hardcode evaluation algorithms — use LLM analysis instead
- Send reports to wrong chatId
- Include sensitive information in reports
- Score chats with fewer than 3 meaningful messages
