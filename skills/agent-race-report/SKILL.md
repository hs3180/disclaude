---
name: agent-race-report
description: Agent framework performance analysis specialist - analyzes chat history to compare model/provider performance metrics (response time, cost, token usage, success rate). Use when user says keywords like "模型对比", "框架评估", "Agent表现", "race report", "performance analysis", "模型赛马". Triggered by scheduler for automated weekly execution.
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Agent Race Report

Analyze chat history to compare agent framework/model performance and generate evaluation reports.

## When to Use This Skill

**Use this skill for:**
- Comparing performance across different AI models/providers
- Analyzing agent response time, cost, and token usage
- Generating weekly/monthly performance reports
- Identifying which model/provider performs best for specific task types

**Keywords that trigger this skill**: "模型对比", "框架评估", "Agent表现", "race report", "performance analysis", "模型赛马"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero-code-invasion analysis**: Read existing chat logs directly and extract performance metrics from message metadata. Do NOT modify any core agent code.

---

## Analysis Process

### Step 1: Read Chat History

Read chat history files from the workspace:

```
workspace/chat/
├── oc_chat1.md
├── oc_chat2.md
└── ...
```

Or daily log files:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-04-12.md
│   └── 2026-04-13.md
├── oc_chat2/
│   └── 2026-04-13.md
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/chat/*.md` and `workspace/logs/**/*.md`
2. Read each log file with `Read` tool
3. Focus on recent logs (last 7 days for weekly, 30 days for monthly)

### Step 2: Extract Performance Metrics

From the chat logs, identify and extract the following metrics for each agent interaction:

**Per-message metrics** (look for these patterns in message metadata or inline):

| Metric | Source Pattern | Description |
|--------|---------------|-------------|
| Provider | `provider: xxx` or model prefix | AI provider (anthropic, openai, etc.) |
| Model | `model: xxx` or in metadata | Model name (claude-sonnet-4, gpt-4, etc.) |
| Response Time | `elapsedMs: xxx` or `elapsed: xxx` | Time to generate response |
| Cost | `costUsd: xxx` or `cost: xxx` | Cost in USD |
| Input Tokens | `inputTokens: xxx` | Number of input tokens |
| Output Tokens | `outputTokens: xxx` | Number of output tokens |
| Tool Calls | Tool use blocks in messages | Number of tool invocations |
| Success | Task completion or error indicators | Whether the task was completed successfully |
| Task Type | Content analysis | Category: coding, research, chat, scheduling, etc. |

**How to detect task type from context:**
- **Coding**: mentions files, code, PRs, issues, tests, builds
- **Research**: mentions analyze, investigate, search, explore
- **Chat**: general conversation, Q&A, explanations
- **Scheduling**: mentions cron, schedule, timer, automated tasks
- **Creative**: content generation, writing, brainstorming

**How to detect success/failure:**
- ✅ Success: task completed without error messages
- ❌ Failure: error messages, exceptions, timeouts, "failed", "error", "无法"
- ⚠️ Partial: task partially completed or required user correction

### Step 3: Aggregate Statistics

Group the extracted metrics by **provider + model** combination and compute:

```
For each (provider, model) pair:
- Total interactions count
- Average response time (ms)
- Median response time (ms)
- Total cost (USD)
- Average cost per interaction (USD)
- Total input tokens
- Total output tokens
- Average tokens per interaction
- Success rate (%)
- Average tool calls per interaction
- Task type breakdown (count per type)
```

### Step 4: Generate Comparative Report

Create a structured performance report:

```markdown
## 🏁 Agent Framework 表现报告

**报告时间**: [Timestamp]
**分析范围**: 最近 7 天
**分析消息数**: [Total messages]
**模型数量**: [Number of distinct models]

---

### 📊 模型表现概览

| 排名 | 模型 | 交互数 | 平均响应(ms) | 平均成本($) | 成功率 | 综合评分 |
|------|------|--------|-------------|------------|--------|---------|
| 🥇 | model-a | 42 | 3,200 | 0.035 | 95% | ⭐⭐⭐⭐⭐ |
| 🥈 | model-b | 38 | 2,800 | 0.042 | 89% | ⭐⭐⭐⭐ |
| 🥉 | model-c | 15 | 4,100 | 0.028 | 93% | ⭐⭐⭐⭐ |

---

### 💰 成本分析

| 模型 | 总成本 | 平均成本 | 最贵任务类型 |
|------|--------|---------|------------|
| ... | ... | ... | ... |

---

### ⏱️ 效率分析

| 模型 | 最快响应 | 最慢响应 | 平均工具调用 |
|------|---------|---------|------------|
| ... | ... | ... | ... |

---

### 🎯 任务类型匹配度

| 任务类型 | 最佳模型 | 理由 |
|---------|---------|------|
| Coding | model-a | 成功率最高, 工具调用最少 |
| Research | model-b | 响应快, 覆盖面广 |
| ... | ... | ... |

---

### 💡 洞察与建议

1. **[Insight 1]**: [Observation and recommendation]
2. **[Insight 2]**: [Observation and recommendation]
3. **[Insight 3]**: [Observation and recommendation]

---

### ⚠️ 注意事项

- 数据基于聊天记录分析，可能不包含所有交互
- 成功率基于可检测的任务完成/失败标记
- 建议结合实际使用体验综合判断
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

## Quality Guidelines

### Good Reports:
- ✅ Based on actual chat data, not speculation
- ✅ Quantitative metrics with specific numbers
- ✅ Actionable recommendations
- ✅ Fair comparison across models
- ✅ Acknowledges data limitations

### Avoid:
- ❌ Fabricating metrics that aren't in the data
- ❌ Drawing conclusions from too few samples (< 5 interactions)
- ❌ Ignoring data gaps or inconsistencies
- ❌ Overly complex statistical methods (keep it simple)
- ❌ Sending reports when no meaningful data is found

---

## Edge Cases

### No Data Available
If no chat history files are found or no performance metrics can be extracted:
```
## 🏁 Agent Framework 表现报告

**分析时间**: [Timestamp]

⚠️ 未找到足够的聊天记录或性能数据来生成报告。

**可能原因**:
- 聊天记录目录为空
- 记录中不包含性能元数据
- 分析时间范围内无交互记录

**建议**: 确认 workspace/chat/ 或 workspace/logs/ 目录中有最近的聊天记录。
```

### Insufficient Data
If fewer than 5 interactions per model, note this in the report:
```
⚠️ 注意: 某些模型的样本量较少（< 5 次交互），统计结果可能不具有代表性。
```

---

## Schedule Configuration

To enable weekly reports, create a schedule file:

```markdown
---
name: "Agent Race Report"
cron: "0 9 * * 1"  # Every Monday at 9:00 AM
enabled: true
blocking: true
chatId: "{target_chat_id}"
createdAt: "2026-04-19T00:00:00.000Z"
---

请使用 agent-race-report skill 分析过去 7 天的聊天记录，对比不同模型/provider 的表现，生成周报并发送到当前群聊。

要求：
1. 读取 workspace/chat/ 和 workspace/logs/ 目录下的聊天记录
2. 提取各模型/provider 的性能指标（响应时间、成本、token 用量、成功率）
3. 按任务类型分类统计
4. 生成对比报告并通过 send_user_feedback 发送
```

---

## Checklist

- [ ] Read chat history from `workspace/chat/` and/or `workspace/logs/`
- [ ] Extracted performance metrics from message metadata
- [ ] Grouped and aggregated by provider + model
- [ ] Generated comparative report with actionable insights
- [ ] **Sent report via send_user_feedback** (CRITICAL)
- [ ] Noted any data limitations or insufficient samples

---

## DO NOT

- Modify any core agent code (BaseAgent, AgentMessageMetadata, etc.)
- Create new modules or files in packages/
- Add logging or instrumentation to existing code
- Make assumptions about model performance without data
- Skip the send_user_feedback step
