---
name: agent-benchmark
description: Agent Framework evaluation specialist - analyzes chat history to evaluate and compare agent performance across dimensions like response efficiency, task completion, user feedback, and tool usage. Use when user says keywords like "赛马", "框架评估", "benchmark", "agent评估", "框架对比", "performance comparison", "agent benchmark". Triggered by scheduler for automated weekly execution.
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Agent Benchmark

Analyze chat history to evaluate and compare agent performance across multiple dimensions, generating actionable improvement reports.

## When to Use This Skill

**Use this skill for:**
- Periodic evaluation of agent service quality
- Comparing performance across different chat contexts
- Identifying strengths and weaknesses of agent responses
- Generating benchmark reports for agent improvement

**Keywords that trigger this skill**: "赛马", "框架评估", "benchmark", "agent评估", "框架对比", "performance comparison", "agent benchmark", "服务质量"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based qualitative analysis on chat history to evaluate agent performance.**

Instead of instrumenting code or collecting runtime metrics, this skill reads existing chat logs and uses AI analysis to assess:
- How efficiently the agent responds to requests
- Whether tasks are completed successfully
- How satisfied users appear to be with agent responses
- How effectively the agent uses available tools

This approach is **zero-code-intrusion** — no modifications to BaseAgent, core modules, or any existing code.

---

## Analysis Process

### Step 1: Read Chat Logs

Read chat log files from the logs directory:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-03-05.md
│   └── 2026-03-06.md
├── oc_chat2/
│   └── 2026-03-06.md
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Focus on logs from the analysis period (last 7 days by default, or as specified by user)
3. Read each relevant log file with `Read` tool
4. Skip logs that are clearly test/debug sessions (e.g., very short conversations with only "test" messages)

### Step 2: Evaluate Agent Performance

For each conversation analyzed, evaluate the following dimensions:

#### 2.1 Response Efficiency
- **Response speed**: How quickly does the agent respond to user requests? (infer from message timestamps)
- **First-response quality**: Does the initial response address the user's question, or does the user need to rephrase?
- **Iteration count**: How many back-and-forth rounds before the task is completed?

**Scoring guide:**
| Rating | Criteria |
|--------|----------|
| Excellent | Task completed in 1-2 rounds, user satisfied |
| Good | Task completed in 3-4 rounds, minor clarifications needed |
| Fair | Task completed in 5+ rounds, significant back-and-forth |
| Poor | Task not completed or abandoned by user |

#### 2.2 Task Completion
- **Completion rate**: Percentage of conversations where the stated goal was achieved
- **Abandonment signals**: "算了", "不需要了", "我自己来吧", user stops responding mid-task
- **Success signals**: "谢谢", "搞定了", "可以了", user moves to next topic happily

#### 2.3 User Feedback Signals
- **Positive**: "谢谢", "很好", "完美", "太棒了", gratitude emojis
- **Negative**: "不对", "搞错了", "不是这个意思", frustration indicators
- **Corrections**: How often does the user need to correct agent's output?
- **Repetitive requests**: Same question asked multiple times in the same conversation

#### 2.4 Tool Usage Efficiency
- **Appropriate tool selection**: Does the agent use the right tools for the task?
- **Tool call efficiency**: Are tool calls productive (returning useful results)?
- **Over-tooling**: Does the agent make unnecessary tool calls?
- **Error recovery**: How does the agent handle tool failures?

#### 2.5 Error Patterns
- **Common errors**: Repeated error messages or failure patterns
- **Error recovery**: Does the agent self-correct after errors?
- **Escalation**: Does the agent appropriately ask for help when stuck?

### Step 3: Generate Benchmark Report

Create a structured evaluation report:

```markdown
## Agent Framework Performance Report

**Analysis Period**: [Start Date] - [End Date]
**Chats Analyzed**: [Number]
**Total Conversations**: [Number]

---

### Overall Performance Score

| Dimension | Score | Trend |
|-----------|-------|-------|
| Response Efficiency | X/10 | — |
| Task Completion | X% | — |
| User Satisfaction | X/10 | — |
| Tool Usage | X/10 | — |
| Error Handling | X/10 | — |

---

### Strengths

- [List of things the agent does well, with specific examples]

---

### Weaknesses

#### Issue 1: [Title]
- **Frequency**: X occurrences
- **Example**:
  > [Concrete example from chat]
- **Impact**: [How this affects user experience]
- **Suggested Improvement**: [Specific, actionable suggestion]

---

### Conversation Quality Distribution

| Quality Level | Count | Percentage |
|---------------|-------|------------|
| Excellent (1-2 rounds) | X | X% |
| Good (3-4 rounds) | X | X% |
| Fair (5+ rounds) | X | X% |
| Poor (abandoned) | X | X% |

---

### Notable Conversations

#### Best Performance
> [Summary of a conversation where the agent excelled, what made it great]

#### Needs Improvement
> [Summary of a conversation that went poorly, what went wrong and why]

---

### Recommendations

1. **High Priority**: [Most impactful improvements]
2. **Medium Priority**: [Quality improvements]
3. **Low Priority**: [Nice-to-have improvements]
```

### Step 4: Send Report

**CRITICAL**: Always send the report to the user using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Analysis Guidelines

### What to Evaluate

| Pattern Type | What to Look For | Weight |
|--------------|------------------|--------|
| Response Efficiency | Round count, first-response quality | High |
| Task Completion | Goal achieved vs. abandoned | High |
| User Satisfaction | Positive/negative signals, corrections | Medium |
| Tool Usage | Appropriate selection, efficiency | Medium |
| Error Patterns | Frequency, recovery ability | Low |

### What to Ignore

- Test conversations with obvious test content
- Debugging sessions initiated by the developer
- Conversations with fewer than 3 messages
- System messages (non-user interactions)
- Scheduled task execution logs (identified by "Scheduled Task" prefix)

### Evaluation Fairness

- Consider task complexity when evaluating efficiency — complex tasks naturally require more rounds
- Account for ambiguous user requests — not all failures are the agent's fault
- Distinguish between tool limitations and agent misuse of tools
- Note that different chat contexts may have different difficulty levels

---

## Example Analysis

### Input (Chat History Excerpt):

```
## [2026-03-05T09:15:00Z] User
帮我看看今天有什么新的 GitHub issues

## [2026-03-05T09:15:30Z] Bot
正在检查 issues...
[Uses gh issue list tool]
发现 3 个新 issues:
1. #1234 - Fix login bug (bug)
2. #1235 - Add dark mode (enhancement)
3. #1236 - Update docs (documentation)

## [2026-03-05T09:16:00Z] User
帮我看看 #1234 的详情

## [2026-03-05T09:16:20Z] Bot
[Uses gh issue view tool]
Issue #1234 details: Login fails when...

## [2026-03-05T09:17:00Z] User
谢谢，帮我修一下

## [2026-03-05T09:25:00Z] Bot
[Uses code tools, creates PR]
PR #1237 已提交，修复了登录 bug。
```

### Output (Evaluation):

```
**Conversation Rating: Excellent (9/10)**
- Response Efficiency: 9/10 — All requests answered within seconds, minimal back-and-forth
- Task Completion: 10/10 — User's full request chain was completed (check issues → view detail → fix bug → submit PR)
- Tool Usage: 9/10 — Appropriate tool selection at each step
- Minor note: Could have proactively offered to fix the bug after showing the issue detail
```

---

## Comparison with Other Approaches

| Approach | Code Change | Complexity | Flexibility |
|----------|-------------|------------|-------------|
| **This skill (chat analysis)** | None | Low | High (LLM-driven analysis) |
| Racing engine (PR #1461) | +1,827 lines | Very High | Medium (hardcoded metrics) |
| BaseAgent metrics (PR #1467) | Intrusive | Medium | Low (coupled to agent code) |

This skill achieves the same goal through **zero code changes**, leveraging the LLM's natural ability to understand and evaluate conversations.

---

## Integration with Existing Systems

### Phase 1: Manual / Scheduled Reports (Current)
- Analyze chat history on demand or via scheduler
- Generate evaluation report
- Send via `send_user_feedback`

### Phase 2: Trend Tracking (Future)
- Store reports in `workspace/benchmark/` for historical comparison
- Track score trends over time
- Identify whether improvements are having measurable impact

### Phase 3: Automated Actions (Future)
- Automatically create issues for identified weaknesses
- Suggest skill improvements based on error patterns
- Recommend new skills based on repetitive user requests

---

## Checklist

- [ ] Read all chat log files from workspace/logs/ for the analysis period
- [ ] Analyzed each conversation across all 5 evaluation dimensions
- [ ] Calculated overall performance scores
- [ ] Identified at least 2 strengths and 2 weaknesses (if sufficient data)
- [ ] Generated structured benchmark report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any source code files — this is a pure analysis skill
- Create issues or PRs without user confirmation
- Include personally identifiable or sensitive information in reports
- Make judgments based on insufficient data (note sample size in report)
- Skip the send_user_feedback step
- Compare chats that are clearly different in nature (e.g., casual chat vs. complex coding task) without noting the context difference
