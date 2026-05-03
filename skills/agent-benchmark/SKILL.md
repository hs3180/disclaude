---
name: agent-benchmark
description: Agent Framework benchmarking specialist - analyzes chat logs to compare performance across different agent providers/models, identifying strengths, weaknesses, and unique capabilities. Use when user says keywords like "赛马", "benchmark", "框架对比", "性能评估", "agent 比较", "model comparison". Triggered by scheduler for periodic execution.
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Agent Benchmark

Analyze chat logs to compare agent framework/model performance, identifying strengths, weaknesses, and unique capabilities across different providers.

## When to Use This Skill

**Use this skill for:**
- Periodic agent framework performance comparison
- Identifying which provider/model handles specific tasks better
- Detecting quality degradation or improvement over time
- Discovering unique framework capabilities that can't be directly compared
- Generating benchmark reports for decision-making

**Keywords that trigger this skill**: "赛马", "benchmark", "框架对比", "性能评估", "agent 比较", "model comparison", "framework racing"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based analysis to compare agent performance from real chat history.**

Unlike traditional benchmarking (which uses synthetic tasks), this approach evaluates agents based on **actual production interactions**, providing insights that reflect real-world quality:

- Users interact with agents naturally (no artificial constraints)
- Task complexity varies naturally (not predetermined test suites)
- Satisfaction signals come from genuine feedback (not simulated ratings)

---

## Analysis Process

### Step 1: Read Chat Logs

Read chat log files from the logs directory:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-04-25.md
│   ├── 2026-04-26.md
│   └── ...
├── oc_chat2/
│   └── ...
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Read each log file with `Read` tool
3. Focus on recent logs (last 14 days recommended for meaningful comparison)

If `workspace/logs/` does not exist or is empty, output a "no data" report and stop.

### Step 2: Identify Agent Interactions

For each chat log, identify agent interactions and extract key signals:

#### 2.1 Provider/Model Identification

Agent responses are typically marked with `📤 Bot` or similar markers. While explicit model/provider tags may not always be present in chat logs, infer from context:

- Look for mentions of model names in conversations (e.g., "claude", "gpt", "glm")
- Check if the system configuration mentions providers
- If provider info is not available, analyze all interactions as a single group

#### 2.2 Performance Signal Extraction

From each conversation thread, extract signals for these dimensions:

| Dimension | Signals to Look For | Source |
|-----------|-------------------|--------|
| **Task Completion** | Whether the task was finished vs abandoned | Conversation end state |
| **User Satisfaction** | Thanks, complaints, corrections, re-requests | User messages |
| **Efficiency** | Number of turns to complete a task | Turn counting |
| **Error Rate** | Failures, retries, error messages | Bot messages with errors |
| **Tool Usage** | Tool calls, bash commands, file operations | Bot action indicators |
| **Response Quality** | Relevance, accuracy, completeness of responses | Qualitative assessment |

#### 2.3 Satisfaction Signal Classification

| Signal Type | Positive Examples | Negative Examples |
|-------------|------------------|-------------------|
| **Explicit** | "谢谢", "很好", "完美", "解决了" | "不对", "错了", "没用", "垃圾" |
| **Implicit** | Task accepted without follow-up correction | Same question re-asked, manual corrections |
| **Behavioral** | User delegates more tasks to same agent | User switches to different approach |

### Step 3: Analyze and Compare

#### 3.1 Quantitative Comparison

For each identifiable agent type, compute:

```
For each agent_type:
  - total_interactions: count of conversations
  - avg_turns_to_complete: average conversation turns for completed tasks
  - completion_rate: completed / total
  - satisfaction_rate: positive_signals / total_signals
  - error_rate: errors / total_interactions
  - avg_tool_calls_per_task: total_tool_calls / completed_tasks
```

#### 3.2 Qualitative Analysis

Use LLM reasoning to identify:

1. **Task-Type Strengths**: Which agent handles which types of tasks better
   - Coding tasks
   - Analysis/research tasks
   - Creative tasks
   - Conversational/support tasks

2. **Unique Capabilities**: Features only available in specific frameworks
   - Cannot be directly compared (no apples-to-apples)
   - Examples: specific tool integrations, specialized knowledge, unique interaction patterns

3. **Quality Patterns**:
   - Common failure modes per agent
   - Recovery patterns (how well agents handle errors)
   - User trust indicators (willingness to delegate complex tasks)

### Step 4: Generate Benchmark Report

Create a structured comparison report:

```markdown
## 🏁 Agent Framework Benchmark Report

**分析时间**: [Timestamp]
**分析范围**: 最近 14 天
**聊天数量**: [Number of chats analyzed]
**交互数量**: [Total interactions analyzed]

---

### 📊 总体表现概览

| 指标 | [Agent Type 1] | [Agent Type 2] | 备注 |
|------|---------------|---------------|------|
| 交互数量 | X | Y | — |
| 完成率 | X% | Y% | ⬆️ 越高越好 |
| 满意度 | X% | Y% | ⬆️ 越高越好 |
| 平均轮次 | X | Y | ⬇️ 越低越好 |
| 错误率 | X% | Y% | ⬇️ 越低越好 |
| 工具调用/任务 | X | Y | — |

---

### 🏆 任务类型对比

#### 编码任务
- **[Best Agent]**: [Reason]
- 典型场景: [Example]
- 优势: [Strengths]

#### 分析/研究任务
- **[Best Agent]**: [Reason]
- 典型场景: [Example]
- 优势: [Strengths]

#### 对话/支持任务
- **[Best Agent]**: [Reason]
- 典型场景: [Example]
- 优势: [Strengths]

---

### ✨ 独特能力发现

> 这部分记录无法直接对比的独特特性

#### [Agent Type 1] 独特能力
- [Capability 1]: [Description]
- [Capability 2]: [Description]

#### [Agent Type 2] 独特能力
- [Capability 1]: [Description]
- [Capability 2]: [Description]

---

### 📉 常见问题

#### [Agent Type 1]
1. [Problem 1] (出现 X 次)
2. [Problem 2] (出现 X 次)

#### [Agent Type 2]
1. [Problem 1] (出现 X 次)
2. [Problem 2] (出现 X 次)

---

### 📋 优化建议

1. **路由优化**: [Recommendation for task-to-agent routing]
2. **质量改进**: [Recommendation for improving weak areas]
3. **能力增强**: [Recommendation for leveraging unique capabilities]

---

### 📈 趋势 (与上次报告对比)

> 如果存在历史报告数据，添加趋势分析

| 指标 | 上期 | 本期 | 变化 |
|------|------|------|------|
| [Overall completion rate] | X% | Y% | ↑/↓ |
| [Overall satisfaction] | X% | Y% | ↑/↓ |
```

### Step 5: Send Report

**CRITICAL**: Always send the report to the user using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

### Step 6: Save Historical Data

Append analysis results to `workspace/data/benchmark-history.json` for trend tracking:

```json
{
  "history": [
    {
      "date": "2026-05-01T06:00:00.000Z",
      "period": "14d",
      "chats": 15,
      "interactions": 128,
      "agents": {
        "[agent_type_1]": {
          "interactions": 80,
          "completionRate": 0.92,
          "satisfactionRate": 0.88,
          "avgTurns": 3.2,
          "errorRate": 0.05
        },
        "[agent_type_2]": {
          "interactions": 48,
          "completionRate": 0.85,
          "satisfactionRate": 0.79,
          "avgTurns": 4.1,
          "errorRate": 0.08
        }
      }
    }
  ]
}
```

Use `Bash` to create the directory if needed:
```bash
mkdir -p workspace/data
```

Use `Read` to load existing history, append new entry, then `Write` to save.

---

## Analysis Guidelines

### What to Analyze

| Pattern Type | Description | Minimum for Significance |
|-------------|-------------|------------------------|
| Completion patterns | Task finished vs abandoned | Any occurrence |
| Satisfaction signals | User feedback (positive/negative) | 3+ per agent |
| Error patterns | Failures, retries, timeouts | 2+ per agent |
| Efficiency patterns | Turn count, tool usage | 5+ interactions per agent |

### What to Ignore

- Test/debug messages
- System notifications
- Single-turn informational queries (not tasks)
- Off-topic conversations

### Handling Missing Data

- If agent type cannot be identified, group all interactions together and note "Provider info unavailable"
- If a dimension has insufficient data (< 3 interactions), mark as "Insufficient data" rather than guessing
- If no chat logs exist, generate a minimal report explaining the situation

---

## Example Analysis

### Input (Chat History Excerpt):

```
## [2026-04-28T09:15:00Z] 📥 User
帮我写一个 TypeScript 函数来验证邮箱地址

## [2026-04-28T09:15:45Z] 📤 Bot
这里是一个邮箱验证函数：
```typescript
function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
```

## [2026-04-28T09:16:00Z] 📥 User
不对，这个正则太简单了，应该也支持 + 号别名

## [2026-04-28T09:16:30Z] 📤 Bot
你说得对，这是改进版：
```typescript
function validateEmail(email: string): boolean {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);
}
```

## [2026-04-28T09:16:45Z] 📥 User
好的谢谢
```

### Analysis:

```
Task: Email validation function
Turns: 2 (completed after correction)
Satisfaction: Mixed (required correction, but user satisfied after)
Signals:
  - Negative: User correction ("不对")
  - Positive: User acceptance ("好的谢谢")
  - Error: Incomplete first attempt
```

---

## Integration with Other Systems

### Current Phase: Report Only
- Analyze chat history
- Generate benchmark report
- Send via send_user_feedback
- Save historical data for trends

### Future Phase: Smart Routing
- Use benchmark data to recommend optimal agent for specific task types
- Auto-route tasks to best-performing agent

### Future Phase: Continuous Improvement
- Track improvement over time after configuration changes
- A/B testing support for new models/providers

---

## Checklist

- [ ] Read chat log files from workspace/logs/
- [ ] Identify agent interactions and extract performance signals
- [ ] Compare performance across dimensions
- [ ] Identify unique capabilities (non-comparable strengths)
- [ ] Generated structured benchmark report
- [ ] Saved historical data to workspace/data/benchmark-history.json
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Create schedules without user confirmation
- Send reports to wrong chatId
- Include sensitive personal information in reports
- Force comparisons when data is insufficient
- Skip the send_user_feedback step
- Modify any core agent framework code (zero-invasion principle)
