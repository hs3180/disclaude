---
name: agent-race-review
description: Agent Framework quality evaluation specialist - analyzes chat histories to compare performance across different agent types, models, and providers. Use for agent benchmarking, quality evaluation, or when user says keywords like "赛马", "Agent评估", "框架对比", "质量分析", "agent race", "framework comparison". Triggered by scheduler for automated periodic execution.
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Agent Race Review

Analyze chat histories to evaluate and compare the quality of different agent frameworks, models, and providers.

## When to Use This Skill

**Use this skill for:**
- Periodic agent quality evaluation
- Comparing performance across different models/providers
- Identifying strengths and unique characteristics of each agent type
- Generating actionable improvement recommendations

**Keywords that trigger this skill**: "赛马", "Agent评估", "框架对比", "质量分析", "agent race", "framework comparison", "agent benchmark"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based analysis on chat history to evaluate and compare agent performance.**

This skill does NOT modify any core code. It operates entirely as an external observer, analyzing existing chat logs to derive quality metrics.

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
2. Focus on recent logs (last 7 days recommended, configurable)
3. Read each log file with `Read` tool

### Step 2: Identify Agent Interactions

From chat logs, identify interactions with different agent types/providers. Look for:

1. **Agent Type Indicators**
   - Skill names mentioned (e.g., `deep-task`, `issue-solver`, `pr-scanner`)
   - Model identifiers in metadata or log entries
   - Provider information (anthropic, openai, etc.)
   - Task type classifications (coding, analysis, chat, etc.)

2. **Conversation Segments**
   - User request → Agent response pairs
   - Multi-turn conversations (task execution sequences)
   - Tool call patterns and results

### Step 3: Evaluate Dimensions

Analyze each identified agent interaction across these dimensions:

| Dimension | Metrics | How to Detect |
|-----------|---------|---------------|
| **Response Efficiency** | Response time, time to completion | Timestamp gaps between user request and agent completion |
| **Task Completion** | Success rate, iteration count | Whether task was completed or abandoned; number of correction rounds |
| **User Satisfaction** | Positive/negative feedback signals | Thank messages, corrections, complaints, repeated requests |
| **Tool Usage** | Call count, effectiveness | Number of tool calls vs task complexity; failed tool calls |
| **Error Rate** | Failures, retries, timeouts | Error messages, retry patterns, "failed"/"error" keywords |

### Step 4: Generate Comparison Report

Create a structured evaluation report:

```markdown
## 🏁 Agent Framework 质量评估报告

**评估时间**: [Timestamp]
**分析范围**: 最近 7 天
**评估会话数**: [Number of conversations analyzed]

---

### 📊 综合对比

| 维度 | [Agent Type A] | [Agent Type B] | [Agent Type C] |
|------|----------------|----------------|----------------|
| 响应效率 | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 任务完成率 | 85% | 72% | 90% |
| 用户满意度 | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| 工具使用效率 | 平均 3.2 次/任务 | 平均 5.1 次/任务 | 平均 2.8 次/任务 |
| 错误率 | 8% | 15% | 5% |

---

### 🏆 各框架优势

#### [Agent Type A]
- **优势**: ...
- **最佳场景**: ...

#### [Agent Type B]
- **优势**: ...
- **最佳场景**: ...

---

### 💎 独特特性（无法赛马的部分）

> 注意：以下特性是各框架独有的优势，不应被简单排名所掩盖。

- **[Agent Type A]**: [独特的功能/特性]
- **[Agent Type B]**: [独特的功能/特性]

---

### 📋 改进建议

1. **[Agent Type A]**: [具体建议]
2. **[Agent Type B]**: [具体建议]

---

### 🔍 详细数据

[Optional: detailed per-session analysis data]
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

## Evaluation Guidelines

### What to Evaluate

| Category | Indicators | Weight |
|----------|------------|--------|
| Task Success | Completed vs abandoned tasks | High |
| Efficiency | Time and iteration count | High |
| User Feedback | Explicit and implicit satisfaction | Medium |
| Tool Usage | Effectiveness of tool calls | Medium |
| Error Patterns | Failures and recovery | Medium |

### What to Ignore

- Test/debug conversations
- One-off interactions (insufficient data)
- Sessions with explicit "testing" markers
- Conversations shorter than 3 messages

### Minimum Data Requirements

- At least 3 conversations per agent type to make comparisons
- If insufficient data, report what's available and note the limitation
- Do NOT fabricate or extrapolate data

---

## Unique Characteristics (Non-Competitive)

**IMPORTANT**: The issue #1334 explicitly requires acknowledging unique characteristics that cannot be compared through racing:

- **Multi-modal capabilities**: Some agents can process images, others cannot
- **Specialized domain knowledge**: Agents trained for specific tasks
- **Interaction style differences**: Conversational vs task-oriented approaches
- **Integration capabilities**: Different tool and API integrations
- **Context handling**: Long context vs short context specialization

These should be HIGHLIGHTED, not ranked, in the report.

---

## Integration Phases

### Phase 1: Manual Analysis (Current)
- Analyze chat history
- Generate comparison report
- Send via `send_user_feedback`

### Phase 2: Trend Tracking (Future)
- Store historical evaluations in `workspace/data/agent-race-history.json`
- Generate trend reports comparing performance over time
- Detect regressions and improvements

### Phase 3: Automated Optimization (Future)
- Suggest model/provider switches based on performance data
- Recommend task-type to agent mappings
- Auto-adjust routing based on historical quality

---

## Checklist

- [ ] Read chat log files from workspace/logs/
- [ ] Identified interactions from different agent types
- [ ] Evaluated across all 5 dimensions
- [ ] Highlighted unique non-competitive characteristics
- [ ] Generated structured comparison report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core agent code (zero code intrusion)
- Create schedules without user confirmation
- Send reports to wrong chatId
- Include sensitive user data in reports
- Rank unique characteristics that are not directly comparable
- Fabricate evaluation data when insufficient samples exist
- Skip the send_user_feedback step
