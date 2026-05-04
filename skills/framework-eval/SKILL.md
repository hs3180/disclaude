---
name: framework-eval
description: "Agent Framework evaluation specialist - analyzes chat logs and structured logs to evaluate and compare Agent performance across dimensions like response time, task completion, error rate, and user satisfaction. Use when user says keywords like '框架评估', 'Agent评估', '赛马', 'framework eval', 'agent comparison', 'performance analysis'."
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Agent Framework Evaluation

Analyze chat history and structured logs to evaluate and compare Agent Framework performance.

## When to Use This Skill

**Use this skill for:**
- Evaluating Agent framework quality of service
- Comparing performance across different models/providers
- Generating weekly/monthly evaluation reports
- Identifying performance bottlenecks and improvement opportunities

**Keywords that trigger this skill**: "框架评估", "Agent评估", "赛马", "framework eval", "agent comparison", "performance analysis", "服务质量"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based analysis to evaluate Agent performance from chat history and structured logs.**

Zero code invasion — no modifications to BaseAgent or any core module.
All analysis is done by reading existing logs and chat records.

---

## Evaluation Dimensions

| Dimension | Data Source | Metrics |
|-----------|------------|---------|
| Response Efficiency | Chat timestamps | Time between user message and bot response |
| Task Completion | Chat content | Whether the task was completed (user satisfied / no follow-up corrections) |
| Error Rate | Structured logs | Error frequency, timeout patterns |
| User Satisfaction | Chat content | Thank you messages, corrections, repeated requests |
| Tool Usage Efficiency | Structured logs | Tool call frequency, execution time |
| TTFT (Time To First Token) | Structured logs | SDK stream timing data |

---

## Analysis Process

### Step 1: Collect Structured Metrics from Pino Logs

Read structured JSON logs from the service log file:

```bash
LOG_FILE="/tmp/disclaude-stdout.log"

# Check if log file exists and get time range
if [ ! -f "$LOG_FILE" ]; then
  echo "No structured logs found at $LOG_FILE"
fi

# Time range
echo "=== Log time range ==="
grep '^{' "$LOG_FILE" | head -1 | jq -r '.time'
grep '^{' "$LOG_FILE" | tail -1 | jq -r '.time'

# TTFT metrics (from BaseAgent stream timing)
echo "=== TTFT (Time To First Token) ==="
grep '^{' "$LOG_FILE" | jq -c 'select(.msg | test("First message yielded from SDK stream")) | {time, provider, ttftMs, messageType}' | head -50

# Stream completion timing
echo "=== Stream Completion ==="
grep '^{' "$LOG_FILE" | jq -c 'select(.msg | test("SDK stream completed")) | {time, provider, totalMs, yieldCount, ttftMs}' | head -50

# Error analysis
echo "=== Agent Errors ==="
grep '^{' "$LOG_FILE" | jq -c 'select(.level == "error") | {time, context, msg, chatId}' | head -30

# Timeout patterns
echo "=== Timeout Events ==="
grep '^{' "$LOG_FILE" | jq -c 'select(.msg | test("timeout"; "i")) | {time, context, msg}' | head -20

# Queries per chatId (load distribution)
echo "=== Queries per Chat ==="
grep '^{' "$LOG_FILE" | jq -r 'select(.context == "ChatAgent") | .chatId // "cli"' | sort | uniq -c | sort -rn | head -10
```

### Step 2: Collect Chat Interaction Data

Read chat log files to analyze interaction quality:

```bash
# Find recent chat logs (last 7 days)
CHAT_DIR="workspace/logs/chat"

# List available date directories
ls -la "$CHAT_DIR/" 2>/dev/null

# For each recent date, list chat files
for date_dir in $(ls -d "$CHAT_DIR"/2026-* 2>/dev/null | tail -7); do
  echo "=== $(basename $date_dir) ==="
  ls "$date_dir/"*.md 2>/dev/null | while read f; do
    echo "  $(basename $f): $(wc -l < "$f") lines"
  done
done
```

### Step 3: Analyze Performance

For each chat session found, analyze:

1. **Response Time Analysis**
   - Calculate time delta between 👤 (user) and 🤖 (bot) messages
   - Identify slow responses (>60s) and fast responses (<5s)
   - Average response time per chat

2. **Task Completion Analysis**
   - Count conversations where user expressed satisfaction ("谢谢", "好的", "可以")
   - Count conversations with corrections ("不对", "应该是", "改一下")
   - Count conversations with repeated requests (same intent asked multiple times)
   - Calculate task completion rate

3. **Error Pattern Analysis**
   - From structured logs: count errors per context/module
   - Identify recurring error patterns
   - Calculate error rate per total interactions

4. **User Satisfaction Indicators**
   - Positive signals: "谢谢", "太好了", "完美", "解决了"
   - Negative signals: "不对", "错了", "没用", "不行"
   - Neutral: Single-turn interactions without feedback

### Step 4: Generate Evaluation Report

Create a structured evaluation report:

```markdown
## Agent Framework Evaluation Report

**Evaluation Period**: [Date range]
**Total Chats Analyzed**: [Number]
**Total Messages Analyzed**: [Number]
**Data Sources**: Chat logs + Structured service logs

---

### Summary Score

| Dimension | Score | Trend |
|-----------|-------|-------|
| Response Efficiency | ⭐⭐⭐⭐ | — |
| Task Completion | ⭐⭐⭐ | — |
| Error Rate | ⭐⭐⭐⭐⭐ | — |
| User Satisfaction | ⭐⭐⭐⭐ | — |

---

### Response Time Analysis

- **Average response time**: Xs
- **TTFT (Time To First Token)**: Xms (from structured logs)
- **Slow responses (>60s)**: X occurrences
- **Fast responses (<5s)**: X occurrences

### Task Completion

- **Completion rate**: X% (X out of Y tasks completed)
- **User corrections**: X occurrences
- **Repeated requests**: X occurrences

### Error Analysis

- **Total errors**: X
- **Error rate**: X per 100 interactions
- **Top error categories**:
  1. [Category] — X occurrences
  2. [Category] — X occurrences

### User Satisfaction

- **Positive signals**: X
- **Negative signals**: X
- **Satisfaction ratio**: X%

### Unique Characteristics (Non-raceable)

[List qualitative observations that cannot be measured numerically]
- E.g., "Agent demonstrates strong code understanding in debugging scenarios"
- E.g., "Creative problem-solving approach in architecture discussions"

---

### Recommendations

1. **[High Priority]**: [Recommendation]
2. **[Medium Priority]**: [Recommendation]
3. **[Low Priority]**: [Recommendation]

---

*Generated by framework-eval skill (Issue #1334)*
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

### What to Focus On

| Priority | Signal | Action |
|----------|--------|--------|
| 🔴 High | Error rate > 5% | Report as critical issue |
| 🔴 High | Task completion < 70% | Investigate common failure modes |
| 🟡 Medium | Average response time > 30s | Note as optimization opportunity |
| 🟡 Medium | User corrections > 20% | Suggest prompt/skill improvements |
| 🟢 Low | Satisfaction ratio trends | Track over time |

### What to Ignore

- Test/debug messages
- Single occurrence issues
- Context-specific failures (network issues, etc.)

### Handling Missing Data

- If structured logs are unavailable, rely solely on chat logs
- If chat logs are sparse, analyze whatever is available
- Always note data completeness in the report

---

## Evaluation Period

**Default**: Last 7 days

**Options**:
- Daily: Last 1 day
- Weekly: Last 7 days (default)
- Monthly: Last 30 days

Adjust the date range in Step 2 accordingly.

---

## Example Analysis

### Input (Chat Log Excerpt):

```
👤 [2026-04-28T09:15:00Z] (msg_001)
帮我创建一个定时任务，每天早上检查 issues

🤖 [2026-04-28T09:15:12Z] (msg_002)
好的，我来帮你创建定时任务...

👤 [2026-04-28T09:16:00Z] (msg_003)
不对，我要检查的是有 PR 的 issues，不是所有 issues

🤖 [2026-04-28T09:16:15Z] (msg_004)
明白了，修改筛选条件...
```

### Analysis:

```
Response time: msg_001→msg_002 = 12s (good), msg_003→msg_004 = 15s (good)
Task completion: Required correction (negative signal)
User satisfaction: Initially misunderstood, corrected on second attempt
```

---

## DO NOT

- Modify any agent or core code
- Create new scheduled tasks (recommend to user instead)
- Send reports to wrong chatId
- Include sensitive information in reports
- Make up metrics that aren't supported by the data
- Skip the send_user_feedback step
