---
name: framework-benchmark
description: Agent Framework benchmark specialist - analyzes chat records across multiple chats to evaluate and compare different Agent providers/models. Generates periodic benchmarking reports covering response efficiency, task completion, user satisfaction, tool usage, and error rates. Use when user says keywords like "赛马", "框架对比", "模型评估", "benchmark", "framework comparison", "model evaluation". Triggered by scheduler for automated weekly execution.
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Agent Framework Benchmark

Analyze chat records to evaluate and compare the performance of different Agent providers/models across all chats.

## When to Use This Skill

**Use this skill for:**
- Weekly automated Agent performance benchmarking
- Comparing different models/providers on real user interactions
- Evaluating agent quality across multiple dimensions
- Generating framework comparison reports
- Identifying which model excels at which type of task

**Keywords that trigger this skill**: "赛马", "框架对比", "模型评估", "benchmark", "framework comparison", "model evaluation", "agent race", "provider comparison"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero-intrusion benchmarking via chat record analysis.**

This skill does NOT modify any core agent code or inject metrics collectors. Instead, it analyzes existing chat logs to evaluate real-world agent performance, just as `daily-chat-review` analyzes chat patterns for operational insights.

The analysis dimensions cover both quantitative metrics (extractable from timestamps, tool calls, error messages) and qualitative insights (LLM-interpreted from conversation context).

---

## Analysis Process

### Step 1: Collect Chat Logs

Read all chat log files from the logs directory:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-03-20.md
│   ├── 2026-03-21.md
│   └── ...
├── oc_chat2/
│   └── ...
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Read each log file with `Read` tool
3. Focus on recent logs based on analysis scope:
   - **Weekly report**: last 7 days
   - **Manual trigger**: configurable (default: last 7 days)
4. Skip empty or inaccessible files

### Step 2: Extract Performance Metrics

For each chat session, extract the following metrics by analyzing conversation content:

#### 2.1 Response Efficiency (响应效率)
- **Response time**: Calculate from timestamps between user message and agent response
- **Multi-turn efficiency**: How many rounds needed to complete a task
- **Response completeness**: Whether the agent addressed the full request in one turn

#### 2.2 Task Completion (任务完成度)
- **Completion rate**: Ratio of tasks successfully completed vs. attempted
- **Task types**: Categorize tasks (coding, research, Q&A, troubleshooting, etc.)
- **Completion markers**: Look for indicators like test passing, PR created, answer accepted

#### 2.3 User Satisfaction (用户满意度)
- **Positive signals**: "谢谢", "好的", "可以了", "不错", thumbs-up reactions
- **Negative signals**: "不对", "不是这样", "重来", "换个方式", repeated corrections
- **Neutral signals**: No explicit feedback, follow-up questions
- **Correction rate**: How often user needed to correct agent output

#### 2.4 Tool Usage Efficiency (工具使用效率)
- **Tool call count**: Number of tool invocations per task
- **Tool diversity**: Variety of tools used
- **Unnecessary calls**: Redundant or repeated tool calls indicating inefficiency

#### 2.5 Error Rate (错误率)
- **Task failures**: Tasks that ended without successful completion
- **Retry patterns**: Same task attempted multiple times
- **Error types**: Timeout, authentication, validation, logic errors
- **Self-correction**: Agent detecting and fixing its own errors

### Step 3: Identify Provider/Model Information

Extract provider and model information from chat logs when available:

- Look for model references in agent responses (e.g., "Claude", "GPT", "GLM", "Gemini")
- Check for provider indicators in log metadata
- Note any explicit mentions of model version in conversation
- If model info is not directly available, infer from response patterns:
  - Language style and formatting preferences
  - Tool usage patterns
  - Known capability differences

### Step 4: Generate Benchmark Report

Create a structured benchmarking report:

```markdown
## 🏁 Agent Framework 赛马报告

**分析时间**: [Timestamp]
**分析范围**: [Date range]
**聊天数量**: [Number of chats analyzed]
**消息数量**: [Total messages analyzed]

---

### 📊 总览

| 维度 | 模型 A | 模型 B | 模型 C |
|------|--------|--------|--------|
| 任务完成率 | X% | Y% | Z% |
| 平均响应轮次 | X | Y | Z |
| 用户满意度 | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ |
| 错误率 | X% | Y% | Z% |
| 平均工具调用数 | X | Y | Z |

---

### 🏆 各维度详细分析

#### 1. 响应效率
- **最快**: [Model] — 平均 [X] 轮完成
- **最慢**: [Model] — 平均 [X] 轮完成
- **分析**: [LLM interpretation of why]

#### 2. 任务完成度
- **最高**: [Model] — [X]% 完成率
- **最低**: [Model] — [X]% 完成率
- **典型失败案例**:
  > [Example of a failed task]

#### 3. 用户满意度
- **最高**: [Model] — [X]% 正面反馈
- **改进建议**: [Specific improvement suggestions]

#### 4. 工具使用效率
- **最高效**: [Model] — 平均 [X] 次工具调用/任务
- **最低效**: [Model] — 平均 [X] 次工具调用/任务
- **冗余模式**: [Description of redundant patterns]

#### 5. 错误率
- **最稳定**: [Model] — [X]% 错误率
- **常见错误**: [Most frequent error types]

---

### 🔍 独特特性分析

> "同时也不要忽略 Agent Framework 互相之间存在的独特的特性，这是无法赛马的部分。"

| 模型 | 独特优势 | 典型场景 |
|------|----------|----------|
| [Model A] | [Unique capability] | [When it shines] |
| [Model B] | [Unique capability] | [When it shines] |

**定性分析**:
- [LLM-generated qualitative comparison highlighting unique strengths]

---

### 📈 趋势对比 (与上周相比)

| 维度 | 变化 | 说明 |
|------|------|------|
| 整体完成率 | ↑/↓ X% | [Explanation] |
| 用户满意度 | ↑/↓ X% | [Explanation] |
| 错误率 | ↑/↓ X% | [Explanation] |

---

### 📋 建议

1. **模型选择建议**: [Which model for which type of task]
2. **改进方向**: [What to improve]
3. **关注重点**: [What to watch]
```

### Step 5: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The benchmark report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Analysis Guidelines

### Quantitative Metrics

| Metric | Source | Calculation |
|--------|--------|-------------|
| Response time | Timestamps in logs | `response_time - request_time` |
| Task completion | Conversation outcome | Completed / Total attempted |
| User satisfaction | Feedback keywords | Positive / (Positive + Negative) |
| Tool calls | Tool invocation logs | Count per task |
| Error rate | Error messages | Errors / Total tasks |

### Qualitative Assessment

The LLM should provide qualitative analysis for:
- **Unique capabilities**: Each model's distinctive strengths that cannot be quantified
- **Task-type affinity**: Which model performs best for coding vs. research vs. Q&A
- **Conversation style**: How natural and helpful each model's responses feel
- **Edge case handling**: How well each model handles unusual or ambiguous requests

### Minimum Data Requirements

- **Minimum chats**: 3 chats with agent interactions
- **Minimum messages**: 20 messages total
- If data is insufficient, report the limitation and suggest extending the analysis period

---

## Handling Edge Cases

### Insufficient Data
If there are not enough chat logs to generate meaningful comparisons:
```markdown
## ⚠️ 数据不足

本次分析范围 ([date range]) 内的聊天记录不足以生成有意义的赛马报告。

- **需要**: 至少 3 个包含 Agent 交互的聊天
- **实际**: [X] 个聊天
- **建议**: 扩大分析范围或等待更多数据积累
```

### Single Model Usage
If only one model/provider is detected:
```markdown
## ℹ️ 单一模型检测

当前仅检测到 [Model] 的使用记录，无法进行多模型对比。

### [Model] 单独表现报告
[Generate single-model performance report]
```

### No Model Information
If model/provider information cannot be determined from logs:
- Focus on overall agent performance metrics
- Note the limitation in the report
- Suggest adding model identification to logs for future benchmarking

---

## Integration with Other Systems

### Phase 1: Report Only (Current)
- Analyze chat logs
- Generate benchmark report
- Send via `send_user_feedback`

### Phase 2: Historical Tracking (Future)
- Store benchmark results in `workspace/data/benchmark-history.json`
- Generate trend charts over time
- Detect performance degradation

### Phase 3: Automated Optimization (Future)
- Recommend model switches based on task type
- Alert on significant performance changes
- Integrate with task routing for optimal model selection

---

## Checklist

- [ ] Read all chat log files from workspace/logs/
- [ ] Extracted performance metrics for each chat session
- [ ] Identified provider/model information where available
- [ ] Analyzed both quantitative and qualitative dimensions
- [ ] Generated structured benchmark report
- [ ] Included unique capabilities analysis (non-raceable aspects)
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core agent code or BaseAgent
- Inject metrics collectors or loggers into the framework
- Create new TypeScript modules in packages/
- Make assumptions about which model is "better" without data
- Send reports to wrong chatId
- Include sensitive user information in reports
- Skip the send_user_feedback step
