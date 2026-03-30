---
name: framework-race-analyzer
description: Agent Framework performance analyzer - analyzes chat records and structured logs to compare agent quality across chats, providers, and time periods. Use for framework comparison, performance benchmarking, or when user says keywords like "框架对比", "赛马", "性能分析", "framework race", "benchmark", "agent comparison". Triggered by scheduler for automated weekly execution.
allowed-tools: Read, Glob, Bash, Grep, send_user_feedback
---

# Framework Race Analyzer

Analyze chat records and structured logs to evaluate and compare Agent performance across different chats, providers, and time periods.

## When to Use This Skill

**Use this skill for:**
- Weekly automated agent performance analysis
- Comparing agent quality across different chats or configurations
- Benchmarking response efficiency, task completion, and user satisfaction
- Identifying performance trends and improvement opportunities

**Keywords that trigger this skill**: "框架对比", "赛马", "性能分析", "framework race", "benchmark", "agent comparison", "服务质量评估"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero code intrusion.** This skill performs external analysis of existing chat records and structured logs. It does NOT modify any core agent code, BaseAgent, or framework internals.

The LLM analyzes chat history directly, using prompt-based pattern recognition to extract quality metrics — the same approach as `daily-chat-review`.

---

## Analysis Process

### Step 1: Discover Data Sources

#### 1.1 Chat Records

Use `Glob` to find all chat log files. Support both directory structures:

```
# Date-based structure (current)
workspace/chat/{YYYY-MM-DD}/*.md

# Legacy flat structure (fallback)
workspace/chat/*.md
```

**Actions:**
1. Use `Glob` to find files: `workspace/chat/**/*.md`
2. Focus on recent records (last 7 days for weekly reports, last 30 days for monthly)
3. Skip empty or trivially short files (< 5 messages)

#### 1.2 Structured Logs (Optional - for provider/model info)

Check if structured JSON logs exist:

```bash
ls logs/disclaude-combined.log 2>/dev/null && echo "FOUND" || echo "NOT_FOUND"
```

If found, extract provider/model information from recent log entries:

```bash
grep -E '"provider"' logs/disclaude-combined.log 2>/dev/null | tail -100
```

> **Note**: Structured logs are supplementary. The primary analysis is based on chat records.

#### 1.3 Agent Configuration

Read the current agent configuration to understand provider/model setup:

```bash
cat disclaude.config.yaml 2>/dev/null | grep -A5 'agent:' || echo "No config found"
```

### Step 2: Extract Metrics from Chat Records

For each chat record file, analyze the following dimensions:

#### 2.1 Response Efficiency (响应效率)

Calculate from timestamps between user messages (`👤`) and bot responses (`🤖`):

- **Average Response Time**: Time delta between user message and first bot response
- **Median Response Time**: To avoid outlier skew
- **P95 Response Time**: For identifying slow outliers
- **Response Time Distribution**: Fast (< 10s), Normal (10-60s), Slow (> 60s)

**Pattern to match:**
```
👤 [2026-03-31T10:30:00.000Z] (msg_001)
...

🤖 [2026-03-31T10:30:15.000Z] (msg_002)
...
```

#### 2.2 Task Completion (任务完成度)

Analyze conversation structure to determine if tasks were completed:

- **Completed**: Conversation ends with clear resolution (bot confirms completion, user thanks, or task result delivered)
- **Abandoned**: Conversation trails off without resolution
- **Failed**: Explicit error or inability to complete
- **Multi-turn**: Required more than 3 back-and-forth exchanges

**Indicators of completion:**
- Bot message contains "完成", "成功", "已提交", "done", "completed"
- User says "谢谢", "好的", "thanks"
- Conversation has a natural ending pattern

**Indicators of failure:**
- Bot message contains "失败", "错误", "无法", "error", "failed"
- User says "不对", "重来", "还是不行"
- Multiple retries on the same task

#### 2.3 User Satisfaction (用户反馈)

Identify satisfaction signals from user messages:

| Signal Type | Positive Indicators | Negative Indicators |
|-------------|-------------------|-------------------|
| Explicit | "谢谢", "很好", "完美", "thanks", "great" | "不满意", "很差", "terrible" |
| Implicit | Follow-up on different topic (implies satisfaction) | Repetitive questions (implies dissatisfaction) |
| Correction | None | "不对", "应该是", "改成" (user correcting bot) |

#### 2.4 Tool Usage Efficiency (工具使用效率)

Count tool-related patterns in bot messages:

- **Tool calls per task**: How many tool invocations per completed task
- **Tool diversity**: Different tools used (Bash, Read, Glob, etc.)
- **Redundant tool calls**: Same tool called multiple times for similar purpose
- **Tool error rate**: Tool calls that resulted in errors

#### 2.5 Error Rate (错误率)

Count error patterns:

- **Execution errors**: "Error", "failed", "exit code 1", "ENOENT"
- **Retry patterns**: Same command run multiple times (indicates failure + retry)
- **Timeout indicators**: "timeout", "超时", "timed out"
- **Recovery rate**: Errors that were eventually resolved vs. unresolved

### Step 3: Generate Comparison Report

Create a structured comparison report:

```markdown
## 🏁 Agent Framework 赛马报告

**分析时间**: [Timestamp]
**分析范围**: 最近 [N] 天
**聊天数量**: [Number of chats analyzed]
**消息总数**: [Total messages analyzed]

---

### 📊 总体概览

| 指标 | 值 |
|------|-----|
| 总会话数 | X |
| 完成任务数 | X (完成率: Y%) |
| 平均响应时间 | Xs |
| 中位响应时间 | Xs |
| 用户满意度 | X/Y 正面反馈 |
| 错误率 | X% |

---

### ⚡ 响应效率

| 聊天 | 平均响应 | 中位响应 | P95 | 消息数 |
|------|---------|---------|-----|--------|
| Chat A | 12s | 8s | 45s | 50 |
| Chat B | 15s | 10s | 60s | 30 |

**趋势分析**: [AI-generated qualitative analysis of response patterns]

---

### ✅ 任务完成度

| 聊天 | 已完成 | 进行中 | 失败 | 完成率 |
|------|--------|--------|------|--------|
| Chat A | 15 | 2 | 1 | 83% |
| Chat B | 8 | 3 | 2 | 62% |

**典型失败案例**:
> [Example of a failed task with brief description]

---

### 😊 用户满意度

| 聊天 | 正面反馈 | 负面反馈 | 中性 | 满意度 |
|------|---------|---------|------|--------|
| Chat A | 8 | 1 | 12 | 高 |
| Chat B | 3 | 4 | 8 | 中 |

**典型用户反馈**:
- ✅ "[Positive feedback example]"
- ❌ "[Negative feedback example]"

---

### 🔧 工具使用效率

| 聊天 | 工具调用总数 | 平均/任务 | 错误率 |
|------|------------|----------|--------|
| Chat A | 120 | 6.0 | 5% |
| Chat B | 80 | 8.0 | 12% |

---

### 🐛 错误分析

| 错误类型 | 出现次数 | 涉及聊天 | 恢复率 |
|----------|---------|---------|--------|
| 执行失败 | X | A, B | 80% |
| 超时 | X | A | 50% |
| 重试 | X | B | 100% |

---

### 🏆 综合排名

| 排名 | 聊天 | 综合评分 | 优势 | 待改进 |
|------|------|---------|------|--------|
| 1 | Chat A | 85/100 | 响应快，完成率高 | 减少工具错误 |
| 2 | Chat B | 72/100 | 工具多样 | 降低错误率 |

> **注意**: 综合评分为 AI 基于多维度的定性评估，非硬编码算法。评分会考虑各指标权重和上下文因素。

---

### 📈 趋势分析 (与上周对比)

| 指标 | 上周 | 本周 | 变化 |
|------|------|------|------|
| 平均响应时间 | 15s | 12s | ⬇️ -20% |
| 完成率 | 70% | 83% | ⬆️ +13% |
| 错误率 | 10% | 5% | ⬇️ -50% |

---

### 💡 改进建议

1. **[建议 1**: [Description]
2. **[建议 2]**: [Description]
3. **[建议 3]**: [Description]

---

*报告由 Framework Race Analyzer 自动生成 | 数据来源: 聊天记录 + 结构化日志*
```

### Step 4: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Data Persistence (Optional)

If `workspace/data/` directory exists, save analysis results for trend comparison:

```bash
mkdir -p workspace/data
```

Save to `workspace/data/race-history.json`:
```json
{
  "history": [
    {
      "date": "2026-03-31T09:00:00.000Z",
      "period": "weekly",
      "chatsAnalyzed": 5,
      "totalMessages": 500,
      "avgResponseTime": 12.5,
      "completionRate": 0.83,
      "errorRate": 0.05,
      "satisfactionScore": 0.78
    }
  ]
}
```

When historical data exists, include trend comparison in the report.

---

## Unique Capabilities Recognition

> **Issue Requirement**: "不要忽略 Agent Framework 互相之间存在的独特的特性，这是无法赛马的部分。"

When analyzing, also note qualitative differences that cannot be quantitatively compared:

```markdown
### 🌟 独特特性 (无法赛马的部分)

| 聊天 | 独特能力 | 说明 |
|------|---------|------|
| Chat A | 深度代码理解 | 在复杂重构任务中表现突出，能理解大型代码库的架构关系 |
| Chat B | 创意生成 | 在头脑风暴和方案设计任务中更有创意 |
```

These qualitative observations come from LLM analysis of conversation content, not from metrics.

---

## Analysis Guidelines

### Scope Selection

| Report Type | Default Scope | Schedule |
|-------------|--------------|----------|
| Weekly | Last 7 days | Every Monday 09:00 |
| Monthly | Last 30 days | 1st of month |

### Minimum Data Requirements

- **Minimum chats**: 2 (for comparison to be meaningful)
- **Minimum messages per chat**: 10 (for statistical relevance)
- If below minimums, report "数据不足" and skip comparison

### What to Analyze

| Pattern Type | Method | Source |
|-------------|--------|--------|
| Response time | Timestamp delta | Chat records |
| Task completion | Conversation structure analysis | Chat records |
| User satisfaction | Keyword/pattern matching | Chat records |
| Tool efficiency | Tool call counting | Chat records |
| Error rate | Error pattern counting | Chat records + structured logs |
| Provider/model | Config + structured logs | Config files + logs |

### What to Ignore

- System messages (startup, shutdown, health checks)
- Scheduled task executions (these are automated, not user-driven)
- Very short conversations (< 3 messages)
- Test/debug messages

---

## Checklist

- [ ] Discovered all chat record files
- [ ] Read and analyzed recent chat records (last 7 days)
- [ ] Checked structured logs for provider/model info (if available)
- [ ] Extracted all 5 metric dimensions
- [ ] Identified unique capabilities per chat
- [ ] Generated structured comparison report
- [ ] Included trend analysis (if historical data exists)
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core agent code or BaseAgent
- Add new dependencies or modules
- Create hardcoded ranking algorithms (use AI analysis instead)
- Include sensitive information (API keys, tokens, etc.) in reports
- Send reports to wrong chatId
- Skip the send_user_feedback step
- Make quantitative claims without sufficient data
