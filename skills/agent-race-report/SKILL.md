---
name: agent-race-report
description: "Agent performance analysis specialist - analyzes chat history and service logs to evaluate Agent/framework quality, compares model performance, and generates benchmarking reports. Use for agent evaluation, model comparison, quality assessment, or when user says keywords like '赛马', 'agent评估', '模型对比', '性能分析', 'race report', 'benchmark', 'agent performance'."
allowed-tools: Read, Glob, Bash, Grep, send_user_feedback
---

# Agent Race Report

Analyze chat histories and service logs to evaluate Agent performance, compare different models/frameworks, and generate actionable benchmarking reports.

## When to Use This Skill

**Use this skill for:**
- Periodic Agent quality evaluation (daily/weekly)
- Comparing performance across different models or providers
- Identifying quality trends and degradation
- Generating benchmarking reports for framework decisions
- Triggered by scheduler for automated execution

**Keywords that trigger this skill**: "赛马", "agent评估", "模型对比", "性能分析", "race report", "benchmark", "agent performance", "framework comparison"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based analysis on existing chat records and service logs to evaluate Agent quality — zero code invasion.**

No modifications to `BaseAgent` or any core code. All analysis is performed externally by reading existing data sources.

---

## Data Sources

### Source 1: Chat Logs (Primary)

Chat interaction records stored in:
```
workspace/logs/
├── oc_chat1/
│   ├── 2026-04-01.md
│   └── 2026-04-02.md
├── oc_chat2/
│   └── 2026-04-02.md
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Read each log file with `Read` tool
3. Focus on recent logs (default: last 7 days, configurable)

### Source 2: Service Logs (Supplementary)

Structured pino JSON logs from the disclaude service:
```
/tmp/disclaude-stdout.log
```

Contains structured entries with fields: `level`, `time`, `context`, `msg`, plus metadata like `elapsedMs`, `chatId`, etc.

**Actions:**
```bash
# Agent execution events
grep '^{' /tmp/disclaude-stdout.log | jq -c 'select(.context == "ChatAgent") | {time, msg, chatId, elapsedMs}'

# Error rates by context
grep '^{' /tmp/disclaude-stdout.log | jq -r 'select(.level == "error") | .context' | sort | uniq -c | sort -rn

# Timeout patterns
grep '^{' /tmp/disclaude-stdout.log | jq -c 'select(.msg | test("timeout"; "i")) | {time, context, msg}'
```

---

## Analysis Process

### Step 1: Collect Data

1. Find all chat log files for the analysis period
2. Read chat log content
3. (Optional) Extract service log metrics if available

If `workspace/logs/` directory is empty or doesn't exist, output a brief report: "No chat logs available for analysis."

### Step 2: Identify Agent Types and Models

From chat logs, identify distinct Agent sessions by looking for:
- **Model identifiers**: References to "claude-sonnet", "claude-opus", "glm-4", etc.
- **Agent types**: "skillAgent", "chatAgent", "deepTaskAgent", etc.
- **Provider**: "anthropic", "zhipu/glm", etc.

These may appear in system messages, metadata lines, or agent self-identification within the logs.

### Step 3: Evaluate Quality Dimensions

For each identified Agent/model combination, evaluate these dimensions:

#### 3.1 Response Efficiency
- **Metric**: Average conversation turns to task completion
- **Signals**:
  - Short, successful exchanges (1-3 turns) = high efficiency
  - Long back-and-forth with corrections = low efficiency
  - User repeating the same request = agent not understanding

#### 3.2 Task Completion Rate
- **Metric**: Percentage of tasks that reached a satisfactory conclusion
- **Signals**:
  - User expressing satisfaction ("thanks", "好的", "搞定") = completed
  - User giving up or switching topics = incomplete
  - Agent providing working solutions = completed
  - Agent failing to deliver or producing errors = incomplete

#### 3.3 User Satisfaction
- **Metric**: Qualitative assessment of user happiness
- **Signals**:
  - Positive: "谢谢", "完美", "很好", thumbs up, expressions of gratitude
  - Negative: "不对", "错了", "重来", frustration, repeated corrections
  - Neutral: Simple acknowledgments

#### 3.4 Error and Recovery Rate
- **Metric**: How often the agent encounters errors and recovers
- **Signals**:
  - Tool call failures, API errors, timeout messages
  - Agent self-correction without user intervention = good recovery
  - User needing to restart or rephrase = poor recovery

#### 3.5 Tool Usage Efficiency
- **Metric**: Effective use of available tools
- **Signals**:
  - Choosing appropriate tools for the task
  - Not making unnecessary tool calls
  - Combining tools effectively for complex workflows

### Step 4: Compare and Rank

Create a comparative analysis across Agent types/models:

| Dimension | Agent A (model X) | Agent B (model Y) | Winner |
|-----------|-------------------|-------------------|--------|
| Efficiency | ★★★★☆ | ★★★☆☆ | A |
| Completion | 85% | 70% | A |
| Satisfaction | 4.2/5 | 3.8/5 | A |
| Error Recovery | 90% | 75% | A |
| Tool Usage | ★★★☆☆ | ★★★★☆ | B |

### Step 5: Identify Unique Strengths

Per the original issue requirement, **do not ignore unique characteristics that cannot be compared**:

- Agent A excels at: creative tasks, long-form writing, nuanced understanding
- Agent B excels at: structured data processing, fast responses, code generation
- These qualitative differences are as valuable as quantitative metrics

### Step 6: Generate Report

Create a structured report:

```markdown
## 🏁 Agent Performance Report (赛马报告)

**Analysis Period**: [start] ~ [end]
**Chats Analyzed**: [count]
**Messages Analyzed**: [count]
**Agents Compared**: [count]

---

### 📊 Overall Ranking

| Rank | Agent/Model | Score | Strengths |
|------|-------------|-------|-----------|
| 1 | [Name] | [X/5] | [Top strength] |
| 2 | [Name] | [X/5] | [Top strength] |

---

### 📈 Detailed Comparison

#### [Agent/Model Name]

**Response Efficiency**: ★★★★☆
- Avg turns to completion: X.X
- Successful first-attempt rate: XX%

**Task Completion**: XX%
- Completed: X tasks
- Incomplete: X tasks
- Typical failure mode: [description]

**User Satisfaction**: X.X/5
- Positive signals: X
- Negative signals: X
- Neutral: X

**Error Recovery**: XX%
- Errors encountered: X
- Self-recovered: X
- User intervention needed: X

**Tool Usage**: ★★★★☆
- Appropriate tool selection: [examples]
- Inefficient patterns: [examples]

**Unique Strengths**:
- [Non-comparable positive characteristic]
- [Another unique capability]

**Areas for Improvement**:
- [Specific improvement suggestion]
- [Another suggestion]

---

### 🔑 Key Findings

1. **[Most significant finding]**
   - Impact: [High/Medium/Low]
   - Evidence: [supporting data]

2. **[Second finding]**
   - Impact: [High/Medium/Low]
   - Evidence: [supporting data]

---

### 💡 Recommendations

1. **Model Selection**: For [task type], prefer [Agent/Model] because [reason]
2. **Configuration**: Consider [adjustment] to improve [metric]
3. **Workflow**: [Suggested workflow optimization]

---

### 📋 Methodology

- Data source: Chat logs from `workspace/logs/`
- Analysis period: Last 7 days
- Sample size: [count] conversations
- Scoring: LLM-based qualitative assessment
```

### Step 7: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
send_user_feedback({
  content: [The report in markdown format],
  format: "text",
  chatId: [The chatId from context]
})
```

---

## Analysis Guidelines

### What to Focus On

| Dimension | Weight | Reason |
|-----------|--------|--------|
| Task Completion | 30% | Most important — does the agent deliver? |
| Response Efficiency | 25% | Fewer turns = better UX |
| User Satisfaction | 25% | Direct feedback from users |
| Error Recovery | 10% | Resilience matters |
| Tool Usage | 10% | Efficiency indicator |

### What to Ignore

- Test/debug conversations
- System health messages (not agent quality)
- One-off edge cases without patterns
- Conversations with fewer than 3 messages (too short to evaluate)

### Scoring Scale

| Score | Label | Criteria |
|-------|-------|----------|
| 5/5 | Excellent | Consistently exceeds expectations |
| 4/5 | Good | Mostly reliable, minor issues |
| 3/5 | Average | Gets the job done, nothing special |
| 2/5 | Below Average | Frequent issues, user frustration |
| 1/5 | Poor | Consistently fails or misunderstands |

---

## Error Handling

1. **No chat logs**: Output brief report "No chat logs available for the analysis period."
2. **Insufficient data**: If fewer than 5 conversations found, note limited sample size in report
3. **Single agent only**: Still generate report for that agent, note no comparison available
4. **Service log unavailable**: Skip supplementary analysis, rely on chat logs only
5. **send_user_feedback failure**: Log error, retry once

---

## Checklist

- [ ] Read chat log files from workspace/logs/
- [ ] (Optional) Extract service log metrics
- [ ] Identified distinct Agent types/models
- [ ] Evaluated each quality dimension
- [ ] Generated comparative analysis
- [ ] Included unique strengths (non-comparable)
- [ ] Generated structured report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core Agent code or configuration
- Create new logging infrastructure
- Hard-code ranking algorithms
- Compare agents with fewer than 3 conversations each
- Send reports to wrong chatId
- Include sensitive user information in reports

---

## Schedule Template

See `schedule.md` in the same directory. Copy to `schedules/agent-race-report/SCHEDULE.md`, replace `{chatId}`, and enable.

## Related

- Issue: #1334 (Agent Framework 赛马)
- Reference skill: `daily-chat-review` (chat analysis pattern)
- Rejected approaches: PR #1461 (over-engineered), PR #1467 (code invasion)
