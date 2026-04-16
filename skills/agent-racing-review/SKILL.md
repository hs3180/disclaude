---
name: agent-racing-review
description: Agent performance analysis specialist - reviews chat logs to evaluate and compare agent quality across sessions. Use for weekly performance review, agent quality assessment, or when user says keywords like "Agent 赛马", "框架对比", "性能评估", "质量报告", "agent racing", "performance review".
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Agent Racing Review

Analyze chat history to evaluate agent performance quality, compare across sessions, and generate improvement reports.

## When to Use This Skill

**Use this skill for:**
- Weekly agent performance review
- Comparing quality across different chat sessions
- Identifying strengths and weaknesses in agent responses
- Detecting performance regression over time
- Evaluating user satisfaction signals

**Keywords that trigger this skill**: "Agent 赛马", "框架对比", "性能评估", "质量报告", "agent racing", "performance review", "质量评估"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero code invasion** — analyze existing chat logs to evaluate agent performance. No modifications to core agent code required.

The LLM analyzes message patterns directly from log files, evaluating:
- Response efficiency (TTFR, turnaround time)
- Task completion quality
- Tool usage efficiency
- User satisfaction signals
- Error patterns and recovery

---

## Analysis Process

### Step 1: Read Chat Logs

Read all chat log files from the logs directory:

```
workspace/chat-logs/
├── 2026-04-09/
│   ├── oc_chat1.md
│   └── oc_chat2.md
├── 2026-04-10/
│   ├── oc_chat1.md
│   └── oc_chat3.md
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/chat-logs/**/*.md`
2. Read each log file with `Read` tool
3. Focus on recent logs (last 7 days recommended)

### Step 2: Per-Chat Quality Evaluation

For each chat session, evaluate the following dimensions:

#### 2.1 Response Efficiency
- **TTFR (Time To First Response)**: Measure gap between user message (`👤`) and first bot reply (`🤖`)
- **Multi-turn turnaround**: Average time between user input and bot response across the conversation
- **Quick responses**: Count of responses under 5 seconds (good) vs over 60 seconds (needs attention)

#### 2.2 Task Completion Quality
- Analyze whether user requests were fully addressed
- Identify incomplete tasks (user re-asks the same question, follows up with corrections)
- Detect abandoned tasks (conversation ends without resolution)
- Score: Percentage of user requests that were fully addressed on first attempt

#### 2.3 Tool Usage Efficiency
- Count tool calls per task (from bot messages mentioning tools)
- Identify unnecessary tool calls or redundant invocations
- Detect tool errors or failures
- Score: Average tool calls per successful task completion

#### 2.4 User Satisfaction Signals
- **Positive signals**: User says "谢谢", "很好", "完美", "解决了", "thanks", thumbs up
- **Negative signals**: User says "不对", "错了", "改一下", "不是这个", "重新做"
- **Frustration signals**: User repeats the same request, asks to start over, escalates
- Score: Ratio of positive to negative signals

#### 2.5 Error Patterns
- Bot messages containing error indicators: "失败", "错误", "无法", "error", "failed", "retry"
- Crash indicators: Conversation suddenly stops mid-task
- Recovery success: Whether the agent self-corrected after an error
- Score: Error rate and recovery rate

### Step 3: Cross-Session Comparison

Compare performance across different chat sessions:

| Dimension | Chat A | Chat B | Chat C | Trend |
|-----------|--------|--------|--------|-------|
| Avg TTFR | 8s | 12s | 6s | Improving |
| Task Completion | 85% | 72% | 90% | Improving |
| Error Rate | 5% | 12% | 3% | Improving |
| User Satisfaction | +8/-2 | +5/-4 | +10/-1 | Improving |

Also identify:
- **Best performing sessions**: What patterns make them successful?
- **Underperforming sessions**: What went wrong?
- **Time-based trends**: Is performance improving or degrading over the analysis period?

### Step 4: Unique Capability Detection

Beyond quantitative metrics, identify qualitative strengths that are **unique and cannot be directly compared**:

- Specialized domain knowledge demonstrated in responses
- Creative problem-solving approaches
- Proactive suggestions that went beyond the user's request
- Cross-domain integration capabilities
- Personality/communication style differences

These qualitative observations are valuable even though they cannot be ranked numerically.

### Step 5: Generate Report

Create a structured analysis report:

```markdown
## 🏁 Agent 性能评估报告

**分析时间**: [Timestamp]
**分析范围**: 最近 7 天
**会话数量**: [Number of chat sessions analyzed]
**消息数量**: [Total messages analyzed]

---

### 📊 总体表现

| 指标 | 本周 | 上周(如有) | 趋势 |
|------|------|-----------|------|
| 平均 TTFR | Xs | Xs | ↑/→/↓ |
| 任务完成率 | X% | X% | ↑/→/↓ |
| 错误率 | X% | X% | ↑/→/↓ |
| 用户满意度 | +X/-Y | +X/-Y | ↑/→/↓ |

---

### ⚡ 响应效率

#### 快速响应 (< 5s)
- 会话 X: N 次

#### 需要关注 (> 60s)
- 会话 X: N 次，最慢 Ys
  - 可能原因: [分析]

---

### ✅ 任务完成度

#### 高完成率会话
- 会话 X: 95% 完成率，N 个请求中 N-1 个一次解决

#### 需要改进
- 会话 X: 60% 完成率，常见原因:
  - [具体失败模式]

---

### 🛠️ 工具使用效率

| 会话 | 工具调用次数 | 成功率 | 平均每任务调用 |
|------|------------|--------|--------------|
| 会话 A | N | X% | M |
| 会话 B | N | X% | M |

---

### 😊 用户满意度

#### 正面反馈 (X 次)
> [典型正面评价原文]

#### 需要改进 (Y 次)
> [典型负面反馈原文]

---

### ❌ 错误模式

| 错误类型 | 出现次数 | 涉及会话 | 恢复率 |
|---------|---------|---------|--------|
| [错误类型1] | N | 会话X, Y | X% |

---

### 🌟 独特优势

以下能力无法通过量化指标体现，但在实际使用中展现了独特价值：

- [Agent 展现的独特能力或行为]

---

### 📋 建议的下一步

1. **立即行动**: [高优先级改进项]
2. **计划中**: [中优先级改进项]
3. **观察**: [持续监控的指标]
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

## Evaluation Guidelines

### What to Evaluate

| Dimension | Method | Weight |
|-----------|--------|--------|
| Response Speed | Timestamp diff between 👤 and 🤖 | Medium |
| Task Completion | Analyze whether request was fully addressed | High |
| Tool Efficiency | Count tool calls vs task outcomes | Medium |
| User Satisfaction | Count positive/negative signal keywords | High |
| Error Rate | Count error-related keywords in bot messages | Medium |
| Unique Strengths | Qualitative analysis of response quality | Low |

### What to Ignore

- Test/debug messages
- System notifications
- Very short conversations (< 3 exchanges)
- Sessions with only monologue (no user interaction)

### Scoring

For each dimension, rate on a simple scale:
- 🟢 **Good**: Above average, no issues
- 🟡 **Fair**: Average, some room for improvement
- 🔴 **Needs Attention**: Below average, clear issues

---

## Example Analysis

### Input (Chat History Excerpt):

```
👤 [2026-04-10T09:15:00Z] (msg_001)
帮我检查一下 hs3180/disclaude 仓库的 open issues

🤖 [2026-04-10T09:15:08Z] (msg_002)
正在检查仓库的 open issues...

🤖 [2026-04-10T09:15:12Z] (msg_003)
找到 15 个 open issues，以下是按优先级排序的结果...

👤 [2026-04-10T09:16:00Z] (msg_004)
完美，帮我看看 #1234 的详情

🤖 [2026-04-10T09:16:05Z] (msg_005)
Issue #1234 的详情如下...
```

### Output (Evaluation):

| Dimension | Result |
|-----------|--------|
| TTFR | 8s (Good) |
| Task Completion | ✅ Fully addressed |
| Tool Usage | 1 tool call for task |
| Satisfaction | "完美" (Positive) |
| Errors | None |

---

## Integration with Other Systems

### Current Phase: Report Only
- Analyze chat history
- Generate comparison report
- Send via send_user_feedback

### Future Extensions
- Track metrics over time with persistent storage
- Automated regression alerts
- Integration with issue creation for identified problems
- Per-model/provider breakdown when metadata is available

---

## Checklist

- [ ] Read all chat log files from workspace/chat-logs/
- [ ] Evaluate each session on 5 dimensions
- [ ] Compare performance across sessions
- [ ] Identify unique strengths
- [ ] Generate structured report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Create schedules without user confirmation
- Send reports to wrong chatId
- Include sensitive information in reports
- Make assumptions about user intent
- Skip the send_user_feedback step
- Modify any core agent code
