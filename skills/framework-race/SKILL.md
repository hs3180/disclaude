---
name: framework-race
description: Agent Framework performance comparison specialist - analyzes chat logs to compare agent types, providers, and models without code intrusion. Use for framework benchmarking, model comparison, performance analysis, or when user says keywords like "赛马", "框架对比", "模型比较", "性能分析", "framework race", "benchmark", "model comparison". Triggered by scheduler for automated weekly reports.
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Framework Race

Analyze chat logs to compare Agent Framework/Model performance with zero code intrusion.

## When to Use This Skill

**Use this skill for:**
- Comparing performance of different agent types, providers, or models
- Generating periodic benchmark reports from real usage data
- Identifying which framework/model performs better for specific task types
- Discovering unique strengths of different agent frameworks

**Keywords that trigger this skill**: "赛马", "框架对比", "模型比较", "性能分析", "framework race", "benchmark", "model comparison", "agent comparison", "周报"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero code intrusion. Analyze existing chat logs to evaluate agent performance.**

This skill does NOT modify `BaseAgent` or any core code. It reads existing chat logs and uses LLM-based analysis to extract performance metrics and generate comparison reports.

The LLM analyzes message patterns directly from log files, extracting:
- **Response efficiency**: Message timestamps → response speed
- **Task completion**: Conversation rounds → success/failure
- **User feedback**: Satisfaction signals (thanks, complaints, retries)
- **Tool usage efficiency**: Tool call count vs task complexity
- **Error patterns**: Failures, retries, timeouts

---

## Analysis Process

### Step 1: Discover Available Logs

List all chat log directories to understand the scope of data:

```bash
# List all chat log directories
ls workspace/logs/
```

Each chat has its own subdirectory with date-based markdown log files:
```
workspace/logs/
├── oc_chat1/
│   ├── 2026-03-01.md
│   ├── 2026-03-02.md
│   └── ...
├── oc_chat2/
│   └── ...
└── ...
```

### Step 2: Identify Agent Metadata

For each chat, identify the agent type, provider, and model by reading the log files. Look for metadata patterns such as:

- **System prompts or headers** that indicate agent type (e.g., `skillAgent`, `deepTaskAgent`)
- **Model references** in messages (e.g., `claude-sonnet-4-20250514`, `claude-opus-4-20250514`)
- **Provider references** (e.g., `anthropic`, provider-specific tool names)
- **Task type indicators** (e.g., coding, analysis, research, chat)

If agent metadata is not explicitly logged, infer it from context:
- **Skill-based agents**: Look for skill name mentions in system prompts
- **Model identification**: Check for model-specific behavior patterns or explicit mentions
- **Provider identification**: Infer from available tools and API patterns

### Step 3: Extract Performance Metrics

For each identified agent/model combination, extract the following metrics from chat logs:

#### 3.1 Response Efficiency

- **Response time**: Calculate time between user message and bot response using timestamps
- **Average response time**: Mean response time across all interactions
- **Time to first response**: Latency from user message to first bot action

#### 3.2 Task Completion

- **Completion rate**: Ratio of tasks completed vs tasks attempted
- **Average rounds**: Number of conversation turns per completed task
- **Escalation rate**: Tasks requiring manual intervention or retry

#### 3.3 User Feedback Signals

Look for satisfaction indicators in user messages:

| Signal Type | Positive | Negative |
|-------------|----------|----------|
| Explicit | "谢谢", "好的", "完美", "有用" | "不对", "重做", "改一下", "不是这样" |
| Implicit | Task accepted without correction | Same question asked multiple times |
| Behavioral | Follow-up questions on new topics | Repeated corrections on same topic |

#### 3.4 Tool Usage Efficiency

- **Tool calls per task**: Number of tool invocations per completed task
- **Tool diversity**: Range of different tools used
- **Redundant calls**: Repeated identical tool calls (inefficiency signal)

#### 3.5 Error Patterns

- **Error frequency**: Count of error messages, failures, timeouts
- **Recovery rate**: Tasks that failed initially but succeeded after retry
- **Error types**: Classification of common errors (API, permission, logic, etc.)

### Step 4: Generate Comparison Report

Create a structured comparison report:

```markdown
## 🏁 Agent Framework 赛马报告

**分析时间**: [Timestamp]
**分析范围**: [Date range] (最近 N 天)
**分析聊天数**: [Number of chats]
**总消息数**: [Total messages analyzed]

---

### 📊 总览对比

| 指标 | [Agent A] | [Agent B] | [Agent C] |
|------|-----------|-----------|-----------|
| 聊天数 | X | X | X |
| 平均响应时间 | Xs | Xs | Xs |
| 任务完成率 | X% | X% | X% |
| 平均对话轮次 | X | X | X |
| 用户满意度 | X/5 | X/5 | X/5 |
| 错误率 | X% | X% | X% |

---

### ⏱️ 响应效率分析

[Detailed analysis of response time patterns per agent/model]

**关键发现**:
- [Finding 1]
- [Finding 2]

---

### ✅ 任务完成度分析

[Analysis of task completion rates and patterns]

**关键发现**:
- [Finding 1]
- [Finding 2]

---

### 😊 用户反馈分析

[Analysis of user satisfaction signals]

**正面反馈**:
- [Positive feedback patterns per agent]

**负面反馈**:
- [Negative feedback patterns per agent]

---

### 🔧 工具使用效率

[Analysis of tool usage patterns]

**关键发现**:
- [Finding 1]
- [Finding 2]

---

### ❌ 错误模式分析

[Analysis of error patterns]

**常见错误类型**:
- [Error type 1]: [frequency]
- [Error type 2]: [frequency]

---

### 🌟 独特优势分析

> Each framework has unique characteristics that cannot be simply ranked.

| Agent/Model | 独特优势 | 典型场景 |
|-------------|----------|----------|
| [Agent A] | [Unique strength] | [Best scenario] |
| [Agent B] | [Unique strength] | [Best scenario] |
| [Agent C] | [Unique strength] | [Best scenario] |

---

### 📋 总结与建议

**综合排名** (仅供参考，不代表绝对优劣):
1. 🥇 [Agent A] — [Key strength]
2. 🥈 [Agent B] — [Key strength]
3. 🥉 [Agent C] — [Key strength]

**建议**:
- [Recommendation 1]
- [Recommendation 2]

---

*报告由 framework-race skill 自动生成 | 数据来源: workspace/logs/*
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

## Metric Extraction Guidelines

### What to Measure

| Metric | How to Extract | Minimum Data Points |
|--------|---------------|---------------------|
| Response time | Timestamp diff between user msg and bot response | 5+ interactions |
| Task completion | Analyze conversation outcome (completed/abandoned/escalated) | 3+ tasks |
| User satisfaction | Sentiment analysis of user messages after bot response | 5+ interactions |
| Tool usage | Count tool invocation patterns in bot messages | 3+ tasks |
| Error rate | Count error indicators in bot responses | 5+ interactions |

### Statistical Notes

- **Small sample warning**: If an agent/model has fewer than 5 data points, mark results as "insufficient data" (数据不足)
- **Confidence levels**:
  - 🟢 High: 20+ data points
  - 🟡 Medium: 10-19 data points
  - 🔴 Low: 5-9 data points
  - ⚪ Insufficient: < 5 data points

### What to Ignore

- Test/debug messages
- System maintenance conversations
- Bot self-test interactions
- Conversations with fewer than 3 message exchanges

---

## Handling Multiple Agent Types

When different chats use different agent types/models, compare them side by side.

When the same chat uses multiple agent types over time (e.g., after a model switch):
- Note the switch date
- Compare before/after performance if sufficient data exists
- Treat pre-switch and post-switch as separate data segments

---

## Schedule Configuration

To enable automated periodic reports, create a schedule file:

```markdown
---
name: "Framework Race Weekly Report"
cron: "0 9 * * 1"  # Every Monday at 9:00 AM
enabled: true
blocking: true
chatId: "{target_chat_id}"
---

请使用 framework-race skill 分析过去一周的聊天记录，对比不同 Agent 框架/模型的表现，生成周报。

要求：
1. 读取 workspace/logs/ 目录下的最近 7 天日志
2. 识别不同 agent 类型、provider 和 model
3. 提取响应效率、任务完成度、用户反馈、工具使用、错误率等指标
4. 生成结构化对比报告
5. 使用 send_user_feedback 发送到当前 chatId
```

---

## Integration with Other Systems

### Phase 1: Log Analysis Only (Current)
- Read existing chat logs
- Extract metrics via LLM analysis
- Generate comparison reports
- Zero code intrusion

### Phase 2: Enhanced Metrics (Future)
- If the project adds structured metrics logging (e.g., `race-metrics` keyword), this skill can parse them directly
- Would enable more precise quantitative comparisons

### Phase 3: Trend Analysis (Future)
- Track metric changes over time
- Detect performance regressions
- Correlate with code changes or model updates

---

## Checklist

- [ ] Listed all chat log directories in workspace/logs/
- [ ] Identified agent types/providers/models used
- [ ] Extracted performance metrics for each agent/model
- [ ] Generated structured comparison report
- [ ] Included unique strengths analysis (not just ranking)
- [ ] Marked insufficient data (< 5 data points) appropriately
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify `BaseAgent` or any core code (zero intrusion principle)
- Create new data collection mechanisms or logging
- Hard-code ranking algorithms (use LLM-based analysis)
- Make definitive claims with insufficient data (< 5 data points)
- Ignore unique strengths in favor of simple rankings
- Send reports to wrong chatId
- Include sensitive information in reports
- Skip the send_user_feedback step
