---
name: framework-racing
description: Agent Framework performance comparison specialist - analyzes chat logs across different chats to evaluate and compare agent service quality. Extracts metrics like response efficiency, task completion, user feedback, and error rates. Use for framework comparison, quality benchmarking, or when user says keywords like "赛马", "框架对比", "性能评估", "framework racing", "agent comparison", "benchmark". Triggered by scheduler for periodic evaluation reports.
allowed-tools: Read, Glob, Bash, Grep, send_user_feedback
---

# Agent Framework Racing

Analyze chat logs across different chats to evaluate and compare agent service quality. This skill performs **zero code invasion** analysis — it reads existing chat logs and produces comparison reports without modifying any core code.

## When to Use This Skill

**✅ Use this skill for:**
- Periodic agent service quality evaluation
- Comparing agent performance across different chats/configurations
- Identifying strengths and weaknesses of different agent behaviors
- Generating benchmarking reports from real user interactions
- Detecting which tasks or domains need improvement

**❌ DO NOT use this skill for:**
- Real-time agent monitoring (use system logs instead)
- Code-level performance profiling (use APM tools)
- Modifying agent behavior or configuration

**Keywords that trigger this skill**: "赛马", "框架对比", "性能评估", "服务质量", "framework racing", "agent comparison", "benchmark", "质量报告"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Evaluate agent service quality by analyzing existing chat logs — no code changes required.**

This skill follows the "zero invasion" approach (Issue #1334):
- Does NOT modify `BaseAgent` or any core code
- Does NOT add instrumentation or metrics collection
- Does NOT create new modules or execution engines
- ONLY reads existing chat logs and produces analysis reports

The LLM analyzes message patterns directly from log files, extracting both **quantitative metrics** (response times, task counts) and **qualitative insights** (user satisfaction, unique capabilities).

---

## Analysis Process

### Step 1: Discover Chat Logs

Find all available chat log directories:

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
2. Use `Bash` to list unique chat directories: `ls workspace/logs/`
3. Determine the analysis time range (default: last 7 days)
4. If no log files found, send a brief "no data" message and stop

### Step 2: Read and Analyze Chat Logs

For each chat directory, read the log files within the analysis time range.

**Chat log message format** (for reference):
```
## [2026-03-06T10:30:00.000Z] 📥 User (message_id: xxx)
**Sender**: ou_xxx
**Type**: text
消息内容...
---
## [2026-03-06T10:30:05.000Z] 📤 Bot (message_id: xxx)
**Sender**: bot
**Type**: text
响应内容...
---
```

### Step 3: Extract Evaluation Metrics

For each chat, analyze the following dimensions:

#### 3.1 Response Efficiency (响应效率)
- **TTFR (Time To First Response)**: Time from user message to bot's first response
- **Resolution Time**: Time from initial request to task completion
- **Multi-turn Efficiency**: Average rounds of interaction per task
- **Long Response Detection**: Identify responses exceeding 120 seconds

#### 3.2 Task Completion (任务完成度)
- **Completion Rate**: Tasks successfully resolved vs. total tasks initiated
- **Completion Signals**: Look for indicators like "✅", "完成", "done", "成功"
- **Abandonment Signals**: Look for "算了", "不用了", "never mind", context switches
- **Retry Patterns**: Same task attempted multiple times

#### 3.3 User Feedback (用户满意度)
- **Positive Signals**: "谢谢", "好的", "👍", "有用", "thanks", "great", "perfect"
- **Negative Signals**: "不对", "错了", "不是这样", "重新来", "wrong", "again"
- **Correction Patterns**: User correcting agent output (indicates quality issues)
- **Escalation Patterns**: User repeating the same request (indicates failure to understand)

#### 3.4 Tool Usage Efficiency (工具使用效率)
- **Tool Call Count**: Number of tool invocations per task
- **Tool Diversity**: Variety of tools used
- **Failed Tool Calls**: Tools that returned errors
- **Redundant Operations**: Same tool called multiple times for the same purpose

#### 3.5 Error Rate (错误率)
- **Task Failures**: Tasks that ended without successful resolution
- **Timeouts**: Tasks that exceeded reasonable time limits
- **Retry Rate**: Tasks requiring multiple attempts
- **System Errors**: Infrastructure errors (auth failures, network issues, etc.)

#### 3.6 Unique Characteristics (独特特性)
- **Strengths**: Tasks or domains where the agent excels
- **Specialized Capabilities**: Unique skills or knowledge demonstrated
- **Communication Style**: How the agent interacts with users
- **Creative Solutions**: Novel approaches to problems

> **Important**: This dimension cannot be quantified — the LLM should provide qualitative descriptions.

### Step 4: Generate Comparison Report

Create a structured report comparing agent performance across chats:

```markdown
## 🏁 Agent Framework 赛马报告

**分析时间**: {timestamp}
**分析范围**: {time_range}
**分析聊天数**: {number_of_chats}
**总消息数**: {total_messages}

---

### 📊 总览评分

| 聊天 | 响应效率 | 任务完成度 | 用户满意度 | 工具效率 | 错误率 | 综合 |
|------|----------|-----------|-----------|---------|--------|------|
| {chat1} | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| {chat2} | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |

---

### 📈 详细分析

#### 响应效率
| 聊天 | 平均 TTFR | P50 | P90 | 超时次数 |
|------|-----------|-----|-----|---------|
| {chat1} | {avg}s | {p50}s | {p90}s | {count} |
| {chat2} | {avg}s | {p50}s | {p90}s | {count} |

#### 任务完成度
| 聊天 | 总任务 | 已完成 | 未完成 | 完成率 |
|------|--------|--------|--------|--------|
| {chat1} | {total} | {done} | {undone} | {rate}% |
| {chat2} | {total} | {done} | {undone} | {rate}% |

#### 用户反馈
| 聊天 | 正面反馈 | 负面反馈 | 纠正次数 | 满意度评估 |
|------|---------|---------|---------|-----------|
| {chat1} | {pos} | {neg} | {corr} | {assessment} |
| {chat2} | {pos} | {neg} | {corr} | {assessment} |

#### 错误统计
| 聊天 | 任务失败 | 超时 | 重试 | 系统错误 |
|------|---------|------|------|---------|
| {chat1} | {fail} | {timeout} | {retry} | {sys_err} |
| {chat2} | {fail} | {timeout} | {retry} | {sys_err} |

---

### 🌟 独特特性

#### {chat1} 的独特优势
- {qualitative description of strengths}

#### {chat2} 的独特优势
- {qualitative description of strengths}

> 注：独特特性无法通过指标量化，由 AI 基于对话内容进行定性分析。

---

### 🔍 关键发现

#### 表现突出的领域
- {finding 1}
- {finding 2}

#### 需要改进的领域
- {finding 1}
- {finding 2}

#### 值得关注的模式
- {pattern 1}
- {pattern 2}

---

### 📋 改进建议

1. **高优先级**: {recommendation}
2. **中优先级**: {recommendation}
3. **低优先级**: {recommendation}
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

## Scoring Guidelines

### Star Rating Criteria

| Rating | Response Efficiency | Task Completion | User Satisfaction | Error Rate |
|--------|-------------------|-----------------|-------------------|------------|
| ⭐⭐⭐⭐⭐ | Avg < 5s | > 95% | Almost all positive | < 2% |
| ⭐⭐⭐⭐ | Avg < 15s | > 85% | Mostly positive | < 5% |
| ⭐⭐⭐ | Avg < 30s | > 70% | Mixed feedback | < 10% |
| ⭐⭐ | Avg < 60s | > 50% | Some negative | < 20% |
| ⭐ | Avg > 60s | < 50% | Frequent complaints | > 20% |

### What to Look For

| Dimension | Positive Indicators | Negative Indicators |
|-----------|-------------------|-------------------|
| Response Efficiency | Fast TTFR, few rounds | Long waits, many retries |
| Task Completion | "✅", "完成", clear resolution | "算了", context switches |
| User Satisfaction | "谢谢", "👍", no corrections | "不对", repeated requests |
| Tool Usage | Targeted calls, high success | Redundant calls, failures |
| Error Rate | Clean execution | Timeouts, system errors |

### What to Ignore

- Scheduled/automated messages (no user interaction)
- System notifications (auth events, connection events)
- Test/debug conversations
- Empty or near-empty chats (< 5 messages)

---

## Minimum Data Requirements

| Metric | Minimum Requirement |
|--------|-------------------|
| Messages per chat | ≥ 5 user messages |
| Chats for comparison | ≥ 2 chats with sufficient data |
| Time range | ≥ 3 days recommended |

If minimum data requirements are not met, generate a brief report noting insufficient data rather than fabricating metrics.

---

## Checklist

- [ ] Discovered all chat log directories
- [ ] Read log files within analysis time range
- [ ] Extracted quantitative metrics (TTFR, completion rate, error rate)
- [ ] Analyzed qualitative dimensions (user feedback, unique characteristics)
- [ ] Generated structured comparison report with ratings
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core code or BaseAgent
- Add instrumentation or metrics collection code
- Create new modules or execution engines
- Send reports to wrong chatId
- Include sensitive user information in reports
- Fabricate metrics when data is insufficient
- Make absolute claims without sufficient data samples
- Skip the send_user_feedback step

---

## Historical Context

This skill implements the agreed approach from Issue #1334 after multiple rejected PRs:

| PR | Approach | Why Rejected |
|----|----------|-------------|
| #1461 | Racing execution engine | Over-engineered (+1,827 lines, 6 new files) |
| #1467 | BaseAgent embedded metrics | High code invasion, violates single responsibility |

**Current approach**: Zero-invasion chat log analysis via scheduled task + LLM interpretation.
