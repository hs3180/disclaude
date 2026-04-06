---
name: agent-eval
description: Agent performance evaluation specialist - analyzes chat logs to evaluate and compare agent/framework performance across multiple dimensions. Use for weekly evaluation reports, framework benchmarking, or when user says keywords like "框架评估", "模型对比", "性能分析", "agent evaluation", "framework comparison", "benchmark". Triggered by scheduler for automated weekly execution.
allowed-tools: [Read, Glob, Bash, send_user_feedback]
---

# Agent Performance Evaluation

Analyze chat logs across all chats to evaluate and compare agent/framework performance, generating structured evaluation reports.

## When to Use This Skill

**Use this skill for:**
- Weekly automated agent performance evaluation
- Framework/model comparison across chats
- Service quality assessment
- Identifying underperforming patterns
- Trend analysis over time

**Keywords that trigger this skill**: "框架评估", "模型对比", "性能分析", "agent evaluation", "framework comparison", "benchmark", "赛马"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero-intrusion evaluation through chat log analysis.**

This skill does NOT modify any core code or embed metrics collection into the agent framework. Instead, it analyzes existing chat logs to derive performance insights — keeping the evaluation system completely decoupled from the agent runtime.

---

## Analysis Dimensions

### 1. Response Efficiency (响应效率)

Calculate from message timestamps:

| Metric | Calculation | Target |
|--------|------------|--------|
| Average first response time | Time from user message to first bot response | < 30s |
| Median response time | Median of all response times | < 20s |
| P95 response time | 95th percentile of response times | < 60s |
| Response time trend | Compare current week vs previous week | Improving or stable |

### 2. Task Completion Rate (任务完成度)

Analyze conversation patterns to determine if tasks were completed:

- **Completion signals**: Task marked as done, user confirmed success, follow-up task created
- **Abandonment signals**: User repeated the same request, topic changed without resolution, explicit "算了"/"forget it"
- **Handoff signals**: "Create an issue", "schedule this", escalated to human

**Completion rate** = (completed tasks) / (total tasks identified)

### 3. User Satisfaction (用户反馈)

Detect satisfaction signals from message content:

| Signal Type | Indicators | Sentiment |
|------------|-----------|-----------|
| Positive | "谢谢", "好的", "完美", "不错", "thanks", "great" | 😊 Satisfied |
| Neutral | "收到", "ok", "了解" | 😐 Neutral |
| Negative | "不对", "错了", "不是这样的", "重来", "wrong", "fix" | 😞 Dissatisfied |
| Frustrated | Repeated corrections (3+ times same issue), "到底能不能", "每次都" | 😤 Frustrated |

**Satisfaction score** = (positive - negative) / total feedback messages

### 4. Tool Usage Efficiency (工具使用效率)

Analyze tool call patterns:

- **Average tool calls per task**: Count tool invocations per conversation thread
- **Tool error rate**: Ratio of failed tool calls to total tool calls
- **Tool diversity**: Number of different tools used per task (high diversity may indicate exploration, low may indicate efficiency or limitation)

### 5. Error Rate (错误率)

Count error occurrences:

- **Explicit errors**: Messages containing "Error:", "failed", "超时", "timeout", "ENOTFOUND"
- **Retry patterns**: Same command executed multiple times (indicating transient failures)
- **Recovery rate**: Errors followed by successful completion vs errors leading to abandonment

---

## Analysis Process

### Step 1: Collect Chat Logs

Use Glob to find all chat log files:

```
Glob: workspace/logs/**/*.md
```

Focus on recent logs (default: last 7 days). For weekly reports, analyze the full week.

### Step 2: Read and Parse Logs

For each chat log file:

1. Read the file content with Read tool
2. Identify conversation threads (user request → bot response sequence)
3. Extract timestamps, message types (user/bot), and content

### Step 3: Analyze Per-Chat Metrics

For each chat, compute the five analysis dimensions:

1. **Response Efficiency**: Calculate time deltas between user messages and bot responses
2. **Task Completion**: Identify task boundaries and completion status
3. **User Satisfaction**: Scan for satisfaction signal keywords
4. **Tool Usage**: Count tool invocations and errors
5. **Error Rate**: Count error occurrences and recovery patterns

### Step 4: Cross-Chat Comparison

Aggregate metrics across all chats:

- Rank chats by overall performance score
- Identify top-performing and underperforming chats
- Detect trends compared to previous evaluation (if historical data exists)
- Highlight statistically significant differences

### Step 5: Generate Report

Create a structured evaluation report (see Report Format below).

### Step 6: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
send_user_feedback({
  content: [The report in markdown format],
  format: "text",
  chatId: [The chatId from context]
})
```

---

## Report Format

```markdown
## 🏆 Agent 性能评估报告

**评估时间**: [Timestamp]
**评估范围**: [Date range, e.g., 2026-04-01 ~ 2026-04-07]
**分析聊天数**: [Number of chats analyzed]
**分析消息数**: [Total messages analyzed]

---

### 📊 总览

| 指标 | 本周 | 上周 | 趋势 |
|------|------|------|------|
| 平均响应时间 | Xs | Ys | 📈/📉/➡️ |
| 任务完成率 | X% | Y% | 📈/📉/➡️ |
| 用户满意度 | X% | Y% | 📈/📉/➡️ |
| 工具错误率 | X% | Y% | 📈/📉/➡️ |
| 错误恢复率 | X% | Y% | 📈/📉/➡️ |

---

### ⏱️ 响应效率详情

| Chat | 平均响应 | P95 | 趋势 |
|------|---------|-----|------|
| [chat_name_1] | Xs | Ys | 📈/📉/➡️ |
| [chat_name_2] | Xs | Ys | 📈/📉/➡️ |

---

### ✅ 任务完成度

| Chat | 总任务 | 已完成 | 已放弃 | 完成率 |
|------|--------|--------|--------|--------|
| [chat_name_1] | X | Y | Z | X% |
| [chat_name_2] | X | Y | Z | X% |

---

### 😊 用户满意度

| Chat | 积极 | 中性 | 消极 | 满意度评分 |
|------|------|------|------|-----------|
| [chat_name_1] | X | Y | Z | X% |
| [chat_name_2] | X | Y | Z | X% |

---

### 🔧 工具使用效率

| Chat | 平均调用/任务 | 工具错误率 | 工具多样性 |
|------|-------------|-----------|-----------|
| [chat_name_1] | X | Y% | 高/中/低 |
| [chat_name_2] | X | Y% | 高/中/低 |

---

### 🐛 错误分析

| 错误类型 | 出现次数 | 涉及 Chat | 恢复率 |
|---------|---------|----------|--------|
| [error_type_1] | X | chat1, chat2 | Y% |
| [error_type_2] | X | chat3 | Y% |

---

### 🔍 重点发现

#### ✨ 亮点
- [Highlight 1: e.g., "Chat A 完成率从 60% 提升至 85%"]
- [Highlight 2: e.g., "平均响应时间缩短 30%"]

#### ⚠️ 需关注
- [Concern 1: e.g., "Chat B 连续两周错误率上升"]
- [Concern 2: e.g., "Chat C 用户满意度持续下降"]

#### 💡 改进建议
- [Suggestion 1: e.g., "Chat B 错误集中在工具调用，建议检查相关 MCP 配置"]
- [Suggestion 2: e.g., "高频重复任务可考虑创建 Skill 自动化"]

---

### 📈 历史趋势

[If previous evaluation data exists, show trends over time]

---

*报告由 agent-eval skill 自动生成 | Related: #1334*
```

---

## Trend Tracking

To enable week-over-week comparison, store evaluation results:

### Step 7: Save Evaluation Data

After sending the report, save the raw metrics to a JSON file:

```
Write: workspace/data/agent-eval-history.json
```

Format:
```json
{
  "evaluations": [
    {
      "date": "2026-04-07T00:00:00.000Z",
      "period": "2026-04-01 ~ 2026-04-07",
      "chats": {
        "oc_chat1": {
          "responseTime": { "avg": 12.5, "p95": 35.2, "median": 8.1 },
          "taskCompletion": { "total": 10, "completed": 8, "abandoned": 1, "rate": 0.8 },
          "satisfaction": { "positive": 5, "neutral": 3, "negative": 1, "score": 0.56 },
          "toolUsage": { "avgCallsPerTask": 4.2, "errorRate": 0.05, "diversity": "medium" },
          "errors": { "total": 2, "recovered": 1, "recoveryRate": 0.5 }
        }
      },
      "summary": {
        "totalChats": 5,
        "totalMessages": 234,
        "avgResponseTime": 12.5,
        "avgCompletionRate": 0.78,
        "avgSatisfactionScore": 0.62
      }
    }
  ]
}
```

When a previous evaluation exists in the file, append the new evaluation (keep last 12 weeks of data).

---

## Handling Insufficient Data

If there are not enough chat logs to produce meaningful analysis:

1. **Less than 3 chats with activity**: Report per-chat stats without cross-chat comparison
2. **Less than 10 total messages**: Skip evaluation, send a brief status message
3. **No chat logs found**: Report that no data is available and suggest checking log configuration

---

## Checklist

- [ ] Collected all chat log files from workspace/logs/
- [ ] Parsed timestamps and message types correctly
- [ ] Computed all five analysis dimensions per chat
- [ ] Generated cross-chat comparison
- [ ] Checked for trends against previous evaluation
- [ ] Generated structured report with all sections
- [ ] **Sent report via send_user_feedback** (CRITICAL)
- [ ] Saved evaluation data to workspace/data/agent-eval-history.json

---

## DO NOT

- Modify any core agent code or BaseAgent
- Embed metrics collection into the agent runtime
- Create new TypeScript modules in packages/
- Send reports to wrong chatId
- Include sensitive user data in reports
- Make assumptions about log format without reading actual files
- Fabricate metrics — only report what can be derived from actual chat logs
