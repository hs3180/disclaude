---
name: framework-benchmark
description: Agent Framework performance benchmarking specialist - analyzes chat logs across different agent frameworks to evaluate and compare service quality. Use when user asks for framework comparison, agent evaluation, performance benchmarking, or says keywords like "赛马", "框架对比", "性能评估", "benchmark", "framework comparison", "agent evaluation". Can be triggered by scheduler for periodic automated reports.
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Framework Benchmark

Analyze chat logs across different agent frameworks to evaluate and compare their service quality through AI-driven qualitative analysis.

## When to Use This Skill

**Use this skill for:**
- Periodic benchmarking of agent framework performance
- Comparing service quality across different models/providers
- Generating weekly/monthly framework evaluation reports
- Identifying strengths and weaknesses of each framework

**Keywords that trigger this skill**: "赛马", "框架对比", "性能评估", "benchmark", "framework comparison", "agent evaluation", "模型对比", "服务质量评估", "race metrics"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero code invasion. AI-driven qualitative analysis of real user interactions.**

This skill does NOT modify any core code. It analyzes existing chat logs to evaluate how well different agent frameworks serve users in real conversations.

The evaluation is based on real user interactions, not synthetic benchmarks. This captures qualitative differences that traditional metrics miss.

---

## Analysis Process

### Step 1: Discover Chat Logs

Locate all available chat log directories:

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
2. Identify which chats exist and their date ranges
3. Focus on recent logs (configurable, default: last 7 days; for weekly reports: last 7 days; for monthly: last 30 days)

### Step 2: Extract Agent/Model Metadata

For each chat log, identify:
- **Agent type**: Which agent framework handled the conversation (e.g., skillAgent, projectAgent, directAgent)
- **Model/Provider**: Which LLM was used (e.g., claude-sonnet-4, gpt-4o, deepseek-v3)
- **Task type**: What kind of task was performed (coding, analysis, research, conversation)

Look for metadata markers in the logs such as:
- Model references in system prompts or headers
- Agent type indicators in task descriptions
- Provider/model names in configuration or log entries

### Step 3: Evaluate Across Dimensions

For each agent framework/model combination, evaluate the following dimensions:

#### 3.1 Response Efficiency (响应效率)
- Average response time from user message to agent reply
- First-response latency
- Multi-turn conversation efficiency (does the agent solve in fewer turns?)
- Look for timestamp patterns between user messages and bot responses

#### 3.2 Task Completion (任务完成度)
- Does the agent successfully complete the requested task?
- Are tasks marked as complete, or do they stall?
- Count completed vs. abandoned tasks
- Identify patterns of partial completion

#### 3.3 User Satisfaction Signals (用户满意度)
- Positive signals: "谢谢", "好的", "完美", "可以了", "解决了", thanks, perfect
- Negative signals: "不对", "错了", "重新来", "不是这个", "还是不行", wrong, retry
- Repeated requests for the same task (indicates first attempt failed)
- User corrections or clarifications (indicates misunderstanding)

#### 3.4 Tool Usage Efficiency (工具使用效率)
- Number of tool calls per task
- Appropriate tool selection (right tool for the job)
- Redundant tool calls (same tool called multiple times unnecessarily)
- Failed tool calls and retries

#### 3.5 Error Rate (错误率)
- Task failures, timeouts, crashes
- Retry patterns
- Error recovery success rate
- Common error types

#### 3.6 Qualitative Strengths (独特优势)
This is the dimension that synthetic benchmarks CANNOT capture:
- Does the agent ask clarifying questions when requirements are ambiguous?
- Does the agent proactively suggest better approaches?
- How well does the agent handle edge cases?
- Quality of explanations and documentation
- Creativity in problem-solving
- Context retention across multi-turn conversations

### Step 4: Generate Comparison Report

Create a structured benchmark report:

```markdown
## 🏁 Agent Framework 赛马报告

**分析时间**: [Timestamp]
**分析范围**: [Date range]
**分析聊天数**: [Number of chats]
**消息总量**: [Total messages analyzed]

---

### 📊 综合评分概览

| Framework/Model | 响应效率 | 任务完成度 | 用户满意度 | 工具效率 | 错误率 | 综合评价 |
|-----------------|----------|-----------|-----------|---------|--------|---------|
| [Model A]       | ⭐⭐⭐⭐   | ⭐⭐⭐⭐⭐  | ⭐⭐⭐⭐   | ⭐⭐⭐⭐  | ⭐⭐⭐⭐⭐ | 🏆 领先 |
| [Model B]       | ⭐⭐⭐    | ⭐⭐⭐⭐   | ⭐⭐⭐⭐⭐  | ⭐⭐⭐   | ⭐⭐⭐   | 🥈 良好 |
| [Model C]       | ⭐⭐⭐⭐⭐  | ⭐⭐⭐    | ⭐⭐⭐    | ⭐⭐⭐⭐  | ⭐⭐⭐⭐  | 🥉 一般 |

---

### 🔍 分维度详细分析

#### 1. 响应效率
| Model | 平均响应时间 | 首次响应 | 多轮效率 |
|-------|------------|---------|---------|
| [Model A] | X min | Xs | X 轮/任务 |
| [Model B] | X min | Xs | X 轮/任务 |

**分析**: [AI-driven qualitative analysis of response efficiency patterns]

#### 2. 任务完成度
| Model | 完成任务数 | 未完成 | 完成率 |
|-------|----------|-------|--------|
| [Model A] | X | X | X% |
| [Model B] | X | X | X% |

**典型失败案例**:
> [Example of a task that Model A failed to complete, with analysis of why]

#### 3. 用户满意度
| Model | 正面信号 | 负面信号 | 重复请求 | 净满意度 |
|-------|---------|---------|---------|---------|
| [Model A] | X | X | X | X% |

**典型用户反馈**:
> [Examples of positive and negative user reactions]

#### 4. 工具使用效率
| Model | 平均调用次数 | 冗余调用 | 调用失败率 |
|-------|------------|---------|-----------|
| [Model A] | X | X | X% |

#### 5. 错误率
| Model | 任务失败 | 超时 | 崩溃 | 成功恢复 |
|-------|---------|------|------|---------|
| [Model A] | X | X | X | X% |

---

### ✨ 独特优势对比 (AI定性分析)

> ⚠️ 此维度是传统 benchmark 无法衡量的，基于真实对话的 AI 定性判断

| Model | 独特优势 | 典型表现 |
|-------|---------|---------|
| [Model A] | [e.g., 主动提问澄清需求] | > [Example conversation showing this strength] |
| [Model B] | [e.g., 创造性问题解决] | > [Example conversation showing this strength] |

---

### 📈 趋势分析 (如有历史数据)

对比上期报告的变化趋势...

---

### 💡 建议

1. **推荐场景**: [Which model is best for which type of task]
2. **改进方向**: [What each model could improve]
3. **资源优化**: [Cost-efficiency recommendations]

---

*此报告由 Framework Benchmark Skill 自动生成*
*分析方法: AI 驱动的定性分析，基于真实用户交互记录*
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

| Rating | Criteria |
|--------|----------|
| ⭐⭐⭐⭐⭐ | Excellent: Consistently outstanding, minimal issues |
| ⭐⭐⭐⭐ | Good: Above average, minor issues |
| ⭐⭐⭐ | Average: Meets basic expectations |
| ⭐⭐ | Below Average: Noticeable deficiencies |
| ⭐ | Poor: Significant problems |

### How to Assign Ratings

**Response Efficiency:**
- ⭐⭐⭐⭐⭐: Most tasks completed within expected time, fast first-response
- ⭐⭐⭐⭐: Generally responsive, occasional delays
- ⭐⭐⭐: Average response times, some slow responses
- ⭐⭐: Frequently slow, noticeable delays
- ⭐: Consistently slow, timeouts common

**Task Completion:**
- ⭐⭐⭐⭐⭐: >90% task completion rate
- ⭐⭐⭐⭐: 75-90% completion rate
- ⭐⭐⭐: 50-75% completion rate
- ⭐⭐: 25-50% completion rate
- ⭐: <25% completion rate

**User Satisfaction:**
- ⭐⭐⭐⭐⭐: Mostly positive signals, very few corrections
- ⭐⭐⭐⭐: More positive than negative
- ⭐⭐⭐: Balanced positive/negative
- ⭐⭐: More negative than positive
- ⭐: Mostly negative, frequent complaints

**Tool Efficiency:**
- ⭐⭐⭐⭐⭐: Optimal tool usage, minimal redundancy
- ⭐⭐⭐⭐: Generally efficient, occasional redundancy
- ⭐⭐⭐: Some redundant calls, acceptable
- ⭐⭐: Noticeable redundancy, inefficient patterns
- ⭐: Highly inefficient, excessive tool calls

**Error Rate (inverted - more stars = fewer errors):**
- ⭐⭐⭐⭐⭐: <5% error rate
- ⭐⭐⭐⭐: 5-10% error rate
- ⭐⭐⭐: 10-20% error rate
- ⭐⭐: 20-35% error rate
- ⭐: >35% error rate

---

## Integration with Scheduler

This skill is designed to work with the existing scheduler for periodic automated reports.

### Recommended Schedule Configurations

**Weekly Report (Recommended):**
```yaml
schedules:
  - name: "weekly-framework-benchmark"
    cron: "0 9 * * 1"  # Every Monday 9:00 AM
    prompt: "分析过去一周的聊天记录，对比不同 Agent Framework 的表现，生成赛马周报。分析范围：最近 7 天。"
```

**Monthly Report:**
```yaml
schedules:
  - name: "monthly-framework-benchmark"
    cron: "0 9 1 * *"  # 1st of each month 9:00 AM
    prompt: "分析过去一个月的聊天记录，对比不同 Agent Framework 的表现，生成赛马月报。分析范围：最近 30 天。包含趋势分析。"
```

---

## Important Design Decisions

| Decision | Rationale |
|----------|-----------|
| Prompt-based (no code) | Follows project pattern; LLM analyzes Markdown directly |
| Zero code invasion | Per issue requirements: no modification to BaseAgent or core code |
| Chat log analysis | Captures real user interaction quality, not synthetic metrics |
| AI qualitative analysis | Can evaluate "unique strengths" that quantitative metrics cannot |
| Star rating system | Simple, intuitive, comparable across dimensions |

---

## Checklist

- [ ] Discovered all chat log directories
- [ ] Identified agent/model metadata in logs
- [ ] Analyzed all evaluation dimensions
- [ ] Generated structured comparison report
- [ ] Included qualitative strength analysis
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core code files (this is a zero-invasion skill)
- Use synthetic benchmarks or hardcoded metrics
- Make assumptions about model capabilities without evidence
- Skip the qualitative "unique strengths" analysis
- Send reports to wrong chatId
- Include sensitive user information in reports
