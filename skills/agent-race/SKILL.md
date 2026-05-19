---
name: agent-race
description: Agent framework performance comparison - analyzes chat history and logs to evaluate and compare different Agent SDK providers and models. Use for agent benchmarking, framework comparison, or when user says keywords like "赛马", "框架对比", "性能分析", "agent race", "benchmark", "framework comparison".
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Agent Framework Performance Comparison (Agent Race)

Analyze chat histories and application logs to evaluate and compare the performance of different Agent SDK providers and models.

## When to Use This Skill

**Use this skill for:**
- Comparing different agent frameworks/providers (Anthropic, GLM, OpenAI, etc.)
- Evaluating model performance across specific task types
- Identifying which provider excels at particular workloads
- Generating periodic agent performance reports
- Detecting quality regressions in agent responses

**Keywords that trigger this skill**: "赛马", "框架对比", "性能分析", "agent race", "benchmark", "framework comparison", "模型对比"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Compare agent performance through analysis of real chat history and logs — zero code invasion.**

This skill is a pure analysis tool. It reads existing data and generates insights without modifying any agent code.

---

## Data Sources

### Source 1: Chat History Logs

Read chat logs from the workspace logs directory:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-05-13.md
│   ├── 2026-05-14.md
│   └── 2026-05-15.md
├── oc_chat2/
│   └── 2026-05-15.md
└── ...
```

### Source 2: Application Logs

Read application structured logs (Pino JSON format):

```
logs/disclaude-combined.log
```

Look for entries with these fields:
- `provider` — agent provider (anthropic, glm, openai, etc.)
- `totalMs` — total stream duration
- `ttftMs` — time to first token
- `yieldCount` — number of messages yielded
- `context` — module context (e.g., "BaseAgent", "SkillAgent")

---

## Analysis Process

### Step 1: Collect Data

1. Use `Glob` to find log files: `workspace/logs/**/*.md`
2. Read relevant log files (last 7 days recommended, or as specified by user)
3. If accessible, read application logs: `logs/disclaude-combined.log`
4. Use `Bash` with grep to extract structured entries containing provider/timing data

### Step 2: Extract Metrics

For each provider/model combination found, analyze:

| Metric | Source | How to Measure |
|--------|--------|----------------|
| **Response Speed** | Chat timestamps | Time from user message to first bot response |
| **Task Completion** | Chat content | Whether the task was completed (user confirmed/final result present) |
| **Tool Call Efficiency** | Chat content | Number of tool calls relative to task complexity |
| **Error Rate** | Chat content / App logs | Frequency of errors, retries, timeouts |
| **User Satisfaction** | Chat content | Positive signals (thanks, approval) vs negative (corrections, complaints) |
| **TTFT** | App logs | Time to first token from structured log entries |
| **Total Duration** | App logs | Total stream duration from structured log entries |
| **Unique Capabilities** | Chat content | Qualitative strengths that can't be measured numerically |

### Step 3: Categorize by Task Type

Classify interactions into task types for fair comparison:

- **Coding**: Code writing, debugging, refactoring
- **Research**: Information gathering, analysis, web search
- **Operations**: GitHub operations, CI/CD, deployments
- **Communication**: Report writing, message drafting
- **Mixed**: Multi-step tasks spanning categories

### Step 4: Generate Comparison Report

Create a structured report with these sections:

```markdown
## Agent Framework Performance Report

**Analysis Period**: [Date range]
**Total Interactions Analyzed**: [Number]
**Providers Compared**: [List]

---

### Quantitative Comparison

| Metric | Provider A | Provider B | Provider C |
|--------|-----------|-----------|-----------|
| Avg Response Speed | Xs | Xs | Xs |
| Task Completion Rate | X% | X% | X% |
| Avg Tool Calls/Task | X | X | X |
| Error Rate | X% | X% | X% |
| TTFT (median) | Xms | Xms | Xms |

### By Task Type

| Task Type | Best Provider | Notes |
|-----------|--------------|-------|
| Coding | Provider A | Faster completion, fewer iterations |
| Research | Provider B | More thorough analysis |
| Operations | Provider C | Better tool usage |

### Qualitative Assessment

#### Provider A — Unique Strengths
- [Description of unique capabilities]

#### Provider B — Unique Strengths
- [Description of unique capabilities]

### Recommendations

1. **For coding tasks**: Use Provider A because...
2. **For research tasks**: Use Provider B because...
3. **Considerations**: [Cost, speed, reliability trade-offs]

### Trends (if multiple reports exist)

- [Week-over-week changes]
- [New patterns observed]
- [Quality regressions detected]
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

## Scheduling

This skill can be configured as a scheduled task for periodic analysis:

```yaml
schedules:
  - name: "weekly-agent-race-report"
    cron: "0 9 * * 1"  # Every Monday 9:00
    prompt: "运行 Agent Framework 赛马分析，对比过去一周各 Agent 框架和模型的表现，生成周报"
```

---

## Important Guidelines

### DO
- Compare only similar task types (fair comparison)
- Include sample size for each metric
- Note when sample sizes are too small for reliable conclusions
- Highlight unique capabilities that can't be quantified
- Preserve user privacy (no sensitive content in reports)

### DO NOT
- Compare unrelated task types directly
- Draw conclusions from very small sample sizes (< 3 interactions)
- Include sensitive user data in reports
- Modify any agent code or configuration
- Create new scheduled tasks without user confirmation

---

## Checklist

- [ ] Read chat log files from workspace/logs/
- [ ] Extract performance metrics per provider/model
- [ ] Categorize by task type
- [ ] Generate structured comparison report
- [ ] Include qualitative assessment of unique capabilities
- [ ] **Sent report via send_user_feedback** (CRITICAL)
