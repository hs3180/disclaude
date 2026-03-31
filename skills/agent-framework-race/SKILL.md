---
name: agent-framework-race
description: Agent Framework performance comparison specialist - analyzes chat logs to compare different AI models/providers across multiple dimensions. Use for framework benchmarking, model comparison reports, or when user says keywords like "框架赛马", "模型对比", "性能对比", "framework race", "model comparison", "benchmark". Triggered by scheduler for automated weekly execution.
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Agent Framework Race

Analyze chat logs to compare the performance of different AI models/providers, generating structured benchmarking reports with both quantitative metrics and qualitative insights.

## When to Use This Skill

**Use this skill for:**
- Weekly automated framework/model comparison reports
- Benchmarking different AI providers on real-world tasks
- Identifying which model excels at which type of task
- Tracking model performance trends over time
- Discovering unique strengths of each framework that can't be quantified

**Keywords that trigger this skill**: "框架赛马", "模型对比", "性能对比", "framework race", "model comparison", "benchmark", "赛马报告"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero code intrusion — analyze existing chat logs externally using LLM-based interpretation.**

Do NOT modify any core code. Instead, leverage the existing log infrastructure to extract performance signals and let the AI interpret them holistically, including qualitative differences that pure metrics cannot capture.

---

## Analysis Dimensions

### Quantitative Metrics (from log patterns)

| Dimension | How to Extract | What It Measures |
|-----------|---------------|-----------------|
| **Response Speed** | Time between user message and bot reply timestamps | Latency and throughput |
| **Task Completion** | Conversation turns, explicit completion markers ("done", "✅", task output) | Success rate and efficiency |
| **Error Rate** | Error keywords ("失败", "error", "timeout", "retry", "failed") | Reliability |
| **Tool Usage** | Tool call patterns (Bash, Read, Write, Grep mentions in logs) | Resource utilization |
| **Conversation Length** | Number of turns per task | Conciseness vs thoroughness |

### Qualitative Insights (LLM-interpreted)

| Dimension | What to Look For |
|-----------|-----------------|
| **Code Quality** | Correctness, style, best practices adherence |
| **Reasoning Depth** | Step-by-step explanation quality, consideration of edge cases |
| **Creativity** | Novel approaches, elegant solutions |
| **Instruction Following** | Adherence to constraints, output format compliance |
| **User Satisfaction** | Positive signals ("thanks", "好", "perfect"), negative signals ("不对", "重来", "改成") |

---

## Analysis Process

### Step 1: Discover Available Logs

Scan the logs directory for available data:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-03-25.md
│   └── 2026-03-26.md
├── oc_chat2/
│   └── ...
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Determine the analysis time range (default: last 7 days)
3. Identify which chats contain task-related conversations (vs casual chat)

### Step 2: Identify Models/Providers in Use

From the log content, identify which AI models/providers are being used. Look for indicators such as:

- **Explicit mentions**: Model names in logs (e.g., "claude-sonnet-4", "gpt-4o", "glm-5")
- **Provider indicators**: Provider-specific patterns or configurations
- **Task metadata**: Any structured metadata embedded in logs that identifies the model
- **Config references**: References to agent configuration or provider settings

If models cannot be definitively identified from logs, note this limitation in the report.

### Step 3: Extract Performance Data

For each identified model/provider, extract:

1. **Task Sample**: Collect representative task interactions
   - User requests with clear objectives
   - Bot responses with measurable outcomes
   - Multi-turn conversations showing problem-solving process

2. **Timing Data**: When timestamps are available
   - Time from user request to first bot response (TTFB)
   - Total task completion time
   - Response time distribution (fast/medium/slow)

3. **Outcome Data**:
   - Tasks completed successfully vs. failed
   - Tasks requiring user correction or retry
   - Tasks with explicit user feedback

4. **Error Patterns**:
   - Types of errors encountered
   - Frequency and context of errors
   - Recovery behavior (did the model self-correct?)

### Step 4: Analyze and Compare

Perform comparative analysis across dimensions:

**Per-Dimension Scoring:**
For each dimension where data is available, assess relative performance:

| Rating | Meaning |
|--------|---------|
| ⭐⭐⭐ | Clearly superior |
| ⭐⭐ | Competitive |
| ⭐ | Room for improvement |
| ❓ | Insufficient data |

**Cross-Dimension Patterns:**
- Does a model that's fast also produce lower quality?
- Does a model with high tool usage achieve better results?
- Are there task types where one model consistently outperforms?

### Step 5: Identify Unique Characteristics

**This is the "unique capabilities" that cannot be directly raced.**

For each model, identify qualitative strengths:

- **Claude models**: Known strengths like nuanced reasoning, long-context handling, instruction following
- **GPT models**: Known strengths like broad knowledge, creative generation
- **GLM models**: Known strengths like Chinese language understanding, specific domain expertise

Format as qualitative observations:

```markdown
### 🏆 Unique Strengths

#### [Model A]
- ** standout capability**: [Description with evidence from logs]
- ** notably good at**: [Task type with examples]

#### [Model B]
- ** standout capability**: [Description with evidence from logs]
- ** notably good at**: [Task type with examples]
```

### Step 6: Generate Report

Create a structured comparison report:

```markdown
## 🏁 Agent Framework 赛马报告

**分析时间**: [Timestamp]
**分析范围**: [Date range]
**聊天数量**: [Number of chats analyzed]
**任务样本**: [Number of task interactions analyzed]

---

### 📊 选手阵容

| 模型 | Provider | 检测到的任务数 |
|------|----------|---------------|
| [Model A] | [Provider] | X |
| [Model B] | [Provider] | Y |

---

### 🏃 速度对比

| 维度 | [Model A] | [Model B] | 优势方 |
|------|-----------|-----------|--------|
| 平均首次响应 | Xs | Ys | 🏆 [Winner] |
| 平均任务完成 | Xmin | Ymin | 🏆 [Winner] |

---

### 🎯 完成度对比

| 维度 | [Model A] | [Model B] | 优势方 |
|------|-----------|-----------|--------|
| 一次完成率 | X% | Y% | 🏆 [Winner] |
| 需要纠正次数 | X | Y | 🏆 [Winner] |

---

### 🔧 工具使用对比

| 维度 | [Model A] | [Model B] |
|------|-----------|-----------|
| 平均工具调用/任务 | X | Y |
| 常用工具 | [List] | [List] |

---

### ❌ 错误率对比

| 维度 | [Model A] | [Model B] |
|------|-----------|-----------|
| 错误次数 | X | Y |
| 常见错误类型 | [List] | [List] |
| 自我纠正能力 | ⭐⭐⭐ | ⭐⭐ |

---

### 🏆 独特优势 (无法直接赛马的部分)

#### [Model A]
- **独特优势**: [Description]
- **适用场景**: [When this model shines]

#### [Model B]
- **独特优势**: [Description]
- **适用场景**: [When this model shines]

---

### 📈 趋势分析 (如有历史数据)

- [Performance changes over time]
- [Notable improvements or regressions]

---

### 💡 建议

1. **[Model A] 适合**: [Recommended task types]
2. **[Model B] 适合**: [Recommended task types]
3. **通用建议**: [Overall recommendations]

---

*报告由 agent-framework-race skill 自动生成 | 数据来源: workspace/logs/*
```

### Step 7: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Data Limitations and Handling

### When Data is Insufficient

If logs don't contain enough information for a dimension:

```markdown
> ⚠️ **数据不足**: [Dimension] 无法从现有日志中提取可靠数据。建议在日志中增加 [specific fields] 以改善分析精度。
```

### When Only One Model is Detected

If only one model/provider is found in the logs:

```markdown
> ℹ️ **单模型环境**: 当前日志中仅检测到 [Model]。赛马对比需要至少两个模型的使用数据。当前报告将聚焦于单模型的性能基线分析。
```

### When No Task Data is Found

If logs contain only casual conversation without task-oriented interactions:

```markdown
> ℹ️ **无任务数据**: 当前分析周期内未检测到明确的任务交互。跳过本次报告。
```

---

## Comparison with Previous Approaches

This skill implements the **final approved approach** from Issue #1334, after two previous PRs were rejected:

| Approach | PR | Status | Reason |
|----------|-----|--------|--------|
| Racing Execution Engine | #1461 | ❌ Closed | Over-engineered (+1,827 lines, 6 new files) |
| BaseAgent Metrics Collection | #1467 | ❌ Closed | Code intrusion (modified BaseAgent) |
| **Log Analysis Skill** | This | ✅ Current | Zero intrusion, uses existing scheduler + skill |

---

## Schedule Configuration

To enable automated weekly reports, create a schedule file:

```markdown
---
name: "Weekly Framework Race Report"
cron: "0 9 * * 1"
enabled: true
blocking: true
chatId: "{target_chat_id}"
---

请使用 agent-framework-race skill 分析过去一周的聊天记录，对比不同模型的表现，生成赛马报告。

要求：
1. 读取 workspace/logs/ 目录下的最近 7 天日志
2. 识别使用的不同模型/Provider
3. 提取性能指标进行对比
4. 识别各模型的独特优势
5. 使用 send_user_feedback 发送到当前 chatId
```

---

## Checklist

- [ ] Read chat logs from `workspace/logs/`
- [ ] Identified models/providers in use
- [ ] Extracted quantitative metrics (speed, completion, errors, tool usage)
- [ ] Analyzed qualitative differences (code quality, reasoning, creativity)
- [ ] Identified unique strengths per model
- [ ] Generated structured comparison report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core code or BaseAgent
- Create new modules or packages
- Hard-code model names or rankings
- Make definitive claims without sufficient data
- Skip the send_user_feedback step
- Generate fake metrics — only report what the logs actually show
