---
name: framework-evaluation
description: Agent framework performance evaluation specialist - analyzes chat history across all chats to compare agent service quality, response efficiency, and user satisfaction. Use for weekly/monthly evaluation tasks, framework comparison, or when user says keywords like "框架评估", "赛马", "性能对比", "服务质量", "framework evaluation", "performance comparison". Triggered by scheduler for automated periodic execution.
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Framework Evaluation (Agent 赛马)

Analyze chat history across all chats to evaluate and compare agent framework/model service quality.

## When to Use This Skill

**Use this skill for:**
- Periodic agent service quality evaluation
- Cross-chat performance comparison
- Identifying which agent/model performs best for different task types
- Tracking service quality trends over time
- Generating actionable improvement recommendations

**Keywords that trigger this skill**: "框架评估", "赛马", "性能对比", "服务质量", "framework evaluation", "performance comparison", "agent benchmark"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero-invasion, AI-driven evaluation through chat history analysis.**

This skill does NOT modify any core code or embed metrics collection into the agent framework. Instead, it leverages existing chat logs and the scheduler mechanism to periodically analyze real user interactions.

### Design Philosophy

| Aspect | Approach |
|--------|----------|
| Data Source | Chat history logs (already recorded) |
| Analysis Method | AI-driven qualitative + quantitative analysis |
| Code Invasion | Zero — no changes to BaseAgent or core code |
| Infrastructure | Reuses existing scheduler + skill mechanism |
| Evaluation Scope | Based on real user interactions, not synthetic benchmarks |

---

## Evaluation Dimensions

### 1. Response Efficiency (响应效率)
- **Metrics**: Time between user request and agent response
- **Indicators**: Look at timestamps in chat logs (`[2026-03-05T09:15:00Z]`)
- **Calculation**: Compare `📥 User` timestamp to next `📤 Bot` timestamp
- **Evaluation criteria**:
  - Fast: < 30 seconds for simple queries
  - Acceptable: < 2 minutes for moderate tasks
  - Slow: > 2 minutes (may indicate issues)

### 2. Task Completion Rate (任务完成度)
- **Metrics**: Whether tasks were successfully completed
- **Indicators**:
  - User says "thanks", "done", "perfect" → success
  - User repeats the same request → failure
  - Agent says "I can't", "failed", "error" → failure
  - Follow-up corrections needed → partial success
- **Evaluation criteria**:
  - High: > 80% tasks completed without rework
  - Medium: 60-80% completion rate
  - Low: < 60% completion rate

### 3. User Satisfaction (用户满意度)
- **Metrics**: User feedback signals in conversations
- **Positive signals**: "thanks", "good", "perfect", "exactly what I needed", emoji approval
- **Negative signals**: "wrong", "not what I asked", "try again", "that's not right", repeated corrections
- **Neutral**: Simple acknowledgments, follow-up questions

### 4. Tool Usage Efficiency (工具使用效率)
- **Metrics**: Number of tool calls per task and relevance
- **Indicators**:
  - Excessive tool calls for simple tasks → inefficiency
  - Correct tool selection → good
  - Multiple retries on same tool → potential issue
- **Evaluation criteria**:
  - Efficient: 1-5 tool calls per task
  - Moderate: 5-15 tool calls per task
  - Excessive: > 15 tool calls per task

### 5. Error Rate (错误率)
- **Metrics**: Frequency of errors, failures, and abnormal terminations
- **Indicators**:
  - Error messages in bot responses
  - Task abandonment (conversation ends without resolution)
  - Timeout indicators
  - Retry patterns

### 6. Multi-turn Efficiency (多轮交互效率)
- **Metrics**: Number of turns to complete a task
- **Indicators**:
  - Single-turn completion → excellent
  - 2-3 turns → good
  - 4+ turns → may indicate communication issues
- **Evaluation criteria**:
  - Excellent: Most tasks completed in 1-2 turns
  - Good: Most tasks completed in 2-4 turns
  - Needs improvement: Frequently requires 5+ turns

---

## Analysis Process

### Step 1: Collect Chat Logs

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-03-25.md
│   ├── 2026-03-26.md
│   └── 2026-03-27.md
├── oc_chat2/
│   └── 2026-03-27.md
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Focus on the analysis period (default: last 7 days, configurable)
3. Read each relevant log file

### Step 2: Per-Chat Analysis

For each chat, analyze the following:

1. **Identify task boundaries**: Group consecutive messages into task sessions
   - A "task" starts with a user request and ends with resolution or abandonment
   - Look for topic shifts to identify task boundaries

2. **Extract metrics for each task**:
   - Response time (from timestamps)
   - Tool call count (from tool use indicators in logs)
   - Turn count (user-bot exchange cycles)
   - Outcome (success/partial/failure based on end-of-task signals)

3. **Aggregate per-chat statistics**:
   - Average response time
   - Task completion rate
   - User satisfaction score (positive/neutral/negative ratio)
   - Average turns per task

### Step 3: Cross-Chat Comparison

Compare metrics across different chats to identify patterns:

| Chat | Tasks | Completion Rate | Avg Response | Satisfaction | Error Rate |
|------|-------|----------------|--------------|-------------|------------|
| oc_chat1 | 15 | 87% | 45s | 4.2/5 | 7% |
| oc_chat2 | 8 | 75% | 62s | 3.8/5 | 12% |

### Step 4: Generate Evaluation Report

Create a structured evaluation report:

```markdown
## 🏁 Agent Framework 服务质量评估报告

**评估时间**: [Timestamp]
**评估范围**: [Start Date] ~ [End Date]
**分析聊天数**: [Number of chats]
**分析任务数**: [Total tasks analyzed]

---

### 📊 总体评分

| 维度 | 评分 | 趋势 | 说明 |
|------|------|------|------|
| 响应效率 | ⭐⭐⭐⭐ | ↑ | 平均响应时间 45s |
| 任务完成度 | ⭐⭐⭐⭐ | → | 完成率 82% |
| 用户满意度 | ⭐⭐⭐⭐⭐ | ↑ | 好评率 78% |
| 工具使用效率 | ⭐⭐⭐ | ↓ | 平均 8 次调用/任务 |
| 错误率 | ⭐⭐⭐⭐ | → | 错误率 9% |
| 多轮效率 | ⭐⭐⭐⭐ | → | 平均 2.3 轮/任务 |

---

### 🏆 各聊天表现排名

| 排名 | 聊天 | 综合评分 | 亮点 | 改进点 |
|------|------|----------|------|--------|
| 1 | oc_chat1 | 4.5/5 | 响应快，完成率高 | 工具调用偏多 |
| 2 | oc_chat2 | 4.0/5 | 用户满意度高 | 偶有超时 |
| 3 | oc_chat3 | 3.5/5 | — | 错误率偏高 |

---

### 📈 趋势分析

#### 正面趋势
- [List of improving metrics with evidence]

#### 需关注
- [List of degrading metrics with evidence]

---

### 🔍 典型案例分析

#### ✅ 优秀案例: [Case Description]
- **聊天**: [Chat ID]
- **任务**: [Task description]
- **亮点**: [What went well]
- **可复用**: [Patterns worth replicating]

#### ❌ 问题案例: [Case Description]
- **聊天**: [Chat ID]
- **任务**: [Task description]
- **问题**: [What went wrong]
- **建议**: [How to improve]

---

### 📋 改进建议

| 优先级 | 建议 | 预期收益 | 实施难度 |
|--------|------|----------|----------|
| 🔴 高 | [Suggestion 1] | [Benefit] | [Difficulty] |
| 🟡 中 | [Suggestion 2] | [Benefit] | [Difficulty] |
| 🟢 低 | [Suggestion 3] | [Benefit] | [Difficulty] |

---

### 💡 定性发现

AI-driven qualitative observations that quantitative metrics may miss:
- [Unique strengths observed in specific scenarios]
- [Communication patterns worth noting]
- [User behavior insights]
```

### Step 5: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The evaluation report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Analysis Guidelines

### What to Analyze

| Dimension | Key Questions | Data Sources |
|-----------|--------------|--------------|
| Response Efficiency | How fast does the agent respond? | Timestamps in logs |
| Task Completion | Are tasks completed successfully? | End-of-task signals |
| User Satisfaction | Are users happy with the service? | Feedback keywords |
| Tool Usage | Are tools used efficiently? | Tool call indicators |
| Error Rate | How often do errors occur? | Error messages |
| Multi-turn Efficiency | How many rounds to complete a task? | Message count per task |

### What to Ignore

- Test/debug messages (explicit test scenarios)
- System messages (non-user interactions)
- Scheduled task outputs (automated messages)
- Empty or near-empty conversations

### Confidence Levels

When data is insufficient, indicate confidence level:

| Confidence | Condition | Report Note |
|------------|-----------|-------------|
| 🟢 High | 10+ tasks, 5+ chats | Full analysis |
| 🟡 Medium | 5-10 tasks, 3-5 chats | Analysis with caveats |
| 🔴 Low | < 5 tasks or < 3 chats | Preliminary findings only |

---

## Scheduling

### Recommended Schedule

| Frequency | Cron | Use Case |
|-----------|------|----------|
| Weekly | `0 9 * * 1` (Monday 9:00) | Regular monitoring |
| Bi-weekly | `0 9 1,15 * *` | Less frequent evaluation |
| Monthly | `0 9 1 * *` (1st of month) | High-level overview |

### Configuration

The evaluation period can be adjusted via the schedule prompt:
- Default: last 7 days
- Weekly: last 7 days
- Monthly: last 30 days

---

## Integration with Existing Systems

### Relationship with daily-chat-review

This skill complements `daily-chat-review`:
- **daily-chat-review**: Focuses on identifying repetitive issues and improvement opportunities (daily)
- **framework-evaluation**: Focuses on quantitative performance metrics and cross-chat comparison (weekly/monthly)

Both skills use the same data source (chat logs) but with different analysis perspectives.

### Data Flow

```
Chat Interactions
       ↓
Chat Logs (workspace/logs/)
       ↓
┌──────────────────────┐
│  daily-chat-review   │ → Issue detection (daily)
│  framework-evaluation│ → Performance metrics (weekly)
└──────────────────────┘
       ↓
Evaluation Reports (via send_user_feedback)
```

---

## Example Analysis

### Input (Chat Log Excerpt):

```
## [2026-03-25T09:15:00Z] 📥 User
帮我检查一下最近的 PR 状态

## [2026-03-25T09:15:32Z] 📤 Bot
正在检查 PR 状态...
[Tool: gh pr list --repo xxx --state open]
找到 3 个 open PR:
1. #123 feat: ...
2. #124 fix: ...
3. #125 refactor: ...

## [2026-03-25T09:16:00Z] 📥 User
谢谢，帮我 merge #123

## [2026-03-25T09:16:15Z] 📤 Bot
[Tool: gh pr merge 123 --merge]
✅ PR #123 已合并
```

### Analysis:

| Metric | Value | Assessment |
|--------|-------|------------|
| Response time (first) | 32s | ✅ Fast |
| Response time (second) | 15s | ✅ Very fast |
| Task completion | 100% | ✅ Complete |
| User satisfaction | Positive ("谢谢") | ✅ Satisfied |
| Tool calls | 2 (appropriate) | ✅ Efficient |
| Turns | 2 | ✅ Concise |

---

## Checklist

- [ ] Collected chat logs from analysis period
- [ ] Analyzed all evaluation dimensions
- [ ] Compared metrics across chats
- [ ] Identified top/bottom performers
- [ ] Included at least 1 excellent case study
- [ ] Included at least 1 problem case study
- [ ] Generated actionable improvement recommendations
- [ ] Indicated confidence level
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core code or BaseAgent (zero-invasion principle)
- Create new modules or packages
- Embed metrics collection into agent framework
- Make up metrics — only use data from actual chat logs
- Skip the send_user_feedback step
- Generate reports with insufficient data without noting low confidence
