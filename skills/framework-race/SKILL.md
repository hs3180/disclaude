---
name: framework-race
description: Agent Framework performance comparison analyst - analyzes chat histories across all conversations to evaluate and compare service quality of different models/providers. Generates structured comparison reports with metrics like response efficiency, task completion, user satisfaction, and error rates. Use for weekly benchmarking, model comparison, or when user says keywords like "赛马", "框架对比", "模型对比", "framework race", "model comparison", "performance report". Triggered by scheduler for automated weekly execution.
allowed-tools: Read, Glob, Bash, send_user_feedback
user-invocable: true
---

# Agent Framework Race Report

Analyze chat histories across all conversations to evaluate and compare the service quality of different Agent models/providers, producing a structured comparison report.

## When to Use This Skill

**Use this skill for:**
- Weekly automated service quality comparison
- Comparing performance across different models/providers
- Identifying which model excels at specific task types
- Detecting service quality trends over time
- Spotting unique strengths of each framework that quantitative metrics cannot capture

**Keywords that trigger this skill**: "赛马", "框架对比", "模型对比", "framework race", "model comparison", "performance report", "服务质量"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero code invasion** — evaluate service quality purely by analyzing existing chat history logs. No modifications to BaseAgent or any core code. The LLM interprets chat records holistically, capturing both quantitative patterns and qualitative unique strengths.

---

## Analysis Process

### Step 1: Discover Chat Logs

Use `Glob` to find all chat log files:

```
workspace/logs/**/*.md
```

If the logs directory is empty or doesn't exist, report this and stop.

**Actions:**
1. List all available chat log directories
2. Identify the time range of available logs
3. Focus on the analysis period (default: last 7 days, configurable via `$ARGUMENTS`)

### Step 2: Read and Analyze Chat Histories

For each chat log file:

1. Read the file content with `Read`
2. Analyze messages to extract the following dimensions:

#### 2.1 Response Efficiency (响应效率)
- **Response time**: Time between user message and bot reply (from timestamps)
- **First response latency**: How quickly the bot starts responding
- **Conversation length**: Number of turns to reach resolution
- **Throughput**: Messages processed per time window

#### 2.2 Task Completion (任务完成度)
- **Completion rate**: Ratio of tasks that reached a clear resolution
- **Resolution indicators**: Phrases like "已完成", "done", "fixed", "resolved", success markers
- **Abandonment signals**: Tasks that were dropped without resolution
- **Iteration count**: How many rounds were needed to complete a task

#### 2.3 User Satisfaction (用户满意度)
- **Positive signals**: "谢谢", "好的", "完美", "thanks", "great", "👍", follow-up engagement
- **Negative signals**: "不对", "重做", "错了", "not right", "redo", repeated corrections
- **Neutral patterns**: Simple acknowledgments without sentiment
- **Repeat request rate**: User asking the same thing again (indicates previous failure)

#### 2.4 Tool Usage Efficiency (工具使用效率)
- **Tool call patterns**: Frequency and diversity of tool usage
- **Failed tool calls**: Errors during tool execution
- **Tool efficiency**: Ratio of successful tool calls to total
- **Over-engineering signals**: Excessive tool calls for simple tasks

#### 2.5 Error Rate (错误率)
- **Task failures**: Tasks that ended in error
- **Retry patterns**: Same task attempted multiple times
- **Timeout/crash indicators**: Sudden stops, connection errors
- **Recovery success**: Whether errors were eventually resolved

### Step 3: Identify Model/Provider Information

From the chat logs, identify which model/provider was used for each conversation:
- Look for model identifiers in system messages or metadata
- Check for provider-specific patterns (e.g., different response styles)
- Note any model switches or A/B testing patterns
- If model info is not available in logs, label as "Unknown" and note this limitation

### Step 4: Qualitative Analysis — Unique Strengths

Beyond quantitative metrics, identify qualitative strengths that cannot be "raced":

- **Domain expertise**: Specific knowledge areas where a model excels
- **Communication style**: Clarity, tone, formatting quality
- **Creative problem-solving**: Novel approaches to complex tasks
- **Context retention**: Ability to maintain context across long conversations
- **Proactive behavior**: Anticipating user needs, suggesting improvements

> **Important**: The original issue #1334 explicitly states: "不要忽略Agent Framework互相之间存在的独特的特性，这是无法赛马的部分" (Don't ignore the unique characteristics between Agent Frameworks — these cannot be raced).

### Step 5: Generate Report

Create a structured comparison report:

```markdown
## 🏁 Agent Framework 赛马报告

**分析时间**: [Timestamp]
**分析范围**: [Date range]
**分析聊天数**: [Number of chats]
**涉及模型**: [List of models/providers identified]

---

### 📊 综合评分

| 模型 | 响应效率 | 任务完成度 | 用户满意度 | 工具效率 | 错误率 | 综合 |
|------|---------|-----------|-----------|---------|-------|------|
| [Model A] | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | 🥇 |
| [Model B] | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 🥈 |

> 评分基于聊天记录的 LLM 分析，非精确数值。星级为相对比较。

---

### 📈 详细指标

#### 响应效率
| 模型 | 平均响应时间 | 首次回复延迟 | 平均对话轮次 | 备注 |
|------|------------|------------|------------|------|
| [Model A] | ~Xs | ~Xs | X.X 轮 | ... |
| [Model B] | ~Xs | ~Xs | X.X 轮 | ... |

#### 任务完成度
| 模型 | 完成率 | 平均迭代次数 | 放弃率 | 备注 |
|------|-------|------------|-------|------|
| [Model A] | X% | X.X 次 | X% | ... |
| [Model B] | X% | X.X 次 | X% | ... |

#### 用户满意度
| 模型 | 正面信号 | 负面信号 | 重复请求率 | 备注 |
|------|---------|---------|-----------|------|
| [Model A] | X 次 | X 次 | X% | ... |
| [Model B] | X 次 | X 次 | X% | ... |

#### 错误率
| 模型 | 任务失败 | 重试次数 | 超时/崩溃 | 恢复成功率 | 备注 |
|------|---------|---------|----------|-----------|------|
| [Model A] | X 次 | X 次 | X 次 | X% | ... |
| [Model B] | X 次 | X 次 | X 次 | X% | ... |

---

### 🎯 各模型独特优势（无法赛马的部分）

#### [Model A]
- **独特优势**: [Description of qualitative strengths]
- **典型场景**: [Example scenario where this model shines]
- **用户反馈**: [Representative user feedback]

#### [Model B]
- **独特优势**: [Description of qualitative strengths]
- **典型场景**: [Example scenario where this model shines]
- **用户反馈**: [Representative user feedback]

---

### 📋 趋势观察

- [Trend 1]: [Description]
- [Trend 2]: [Description]
- [Trend 3]: [Description]

---

### 💡 建议

1. **模型选择**: [Which model is better for which use case]
2. **改进方向**: [Areas for improvement]
3. **值得关注的模式**: [Patterns worth monitoring]
```

### Step 6: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Edge Cases

### Insufficient Data
If fewer than 5 conversations are available in the analysis period:
- Expand the time range to include more data (up to 30 days)
- If still insufficient, report the limitation and provide whatever analysis is possible
- Note: "数据量不足，以下分析仅供参考"

### Single Model
If only one model/provider is detected:
- Skip comparative sections
- Focus on single-model quality assessment
- Suggest enabling multi-model configurations for future comparisons

### No Model Information
If model/provider cannot be determined from logs:
- Analyze overall service quality without model distinction
- Note the limitation in the report
- Suggest adding model metadata to logs for future analysis

---

## Schedule Integration

This skill is designed to be triggered by the weekly schedule (`schedules/framework-race.md`).

When invoked by the scheduler, the `$ARGUMENTS` may contain:
- `--period=7d` — Analysis period (default: 7 days)
- `--period=30d` — Monthly analysis
- No arguments — Use default 7-day period

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Zero code invasion** | Per issue #1334 feedback: PR #1467 rejected for modifying BaseAgent |
| **LLM-driven analysis** | AI can capture qualitative differences that hard-coded metrics miss |
| **Chat history as data source** | Real user interactions are more meaningful than synthetic benchmarks |
| **Weekly cadence** | Balance between freshness and statistical significance |
| **Star ratings over numeric scores** | Avoid false precision from small sample sizes |

---

## Checklist

- [ ] Discovered all chat log files from workspace/logs/
- [ ] Read and analyzed each chat's history
- [ ] Extracted quantitative metrics (response time, completion, satisfaction, errors)
- [ ] Identified qualitative unique strengths per model
- [ ] Generated structured comparison report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core code (BaseAgent, Pilot, etc.)
- Hard-code ranking algorithms — let the LLM analyze and interpret
- Make definitive claims from small sample sizes — use tentative language
- Create new log formats or instrumentation
- Send reports to wrong chatId
- Include sensitive user information in reports
