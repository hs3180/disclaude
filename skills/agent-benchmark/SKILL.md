---
name: agent-benchmark
description: Agent Framework quality benchmark specialist - analyzes chat records to evaluate and compare agent performance across different providers, models, and task types. Zero code invasion approach using existing chat logs. Use for weekly reports, performance tracking, or when user says keywords like "Agent 赛马", "框架对比", "性能评估", "benchmark", "framework race", "质量报告". Triggered by scheduler for automated weekly execution.
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Agent Benchmark

Analyze chat records to evaluate and compare agent performance across different providers, models, and task types. Generates structured benchmarking reports with zero code invasion.

## When to Use This Skill

**Use this skill for:**
- Weekly automated agent performance benchmarking
- Comparing different models/providers on similar tasks
- Tracking agent quality trends over time
- Identifying which framework excels at which task type
- Generating service quality reports

**Keywords that trigger this skill**: "Agent 赛马", "框架对比", "性能评估", "benchmark", "framework race", "质量报告", "模型对比", "服务质量"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero code invasion — analyze existing chat records using LLM-based interpretation.**

Do NOT modify any core code, BaseAgent, or framework files. Instead, analyze the rich information already present in chat logs to extract quality metrics.

The key insight: **chat logs already contain all the data needed** — timestamps reveal response speed, message content reveals task completion, user reactions reveal satisfaction, and error messages reveal reliability.

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
3. Focus on recent logs (last 7 days by default, configurable)
4. Group logs by chat for per-chat analysis

### Step 2: Extract Performance Metrics

For each conversation session, analyze and extract:

#### 2.1 Response Efficiency (响应效率)

- **Response Time**: Calculate time between user message and agent response using timestamps
  - Format: `## [2026-03-05T09:15:00Z] 📥 User` → `## [2026-03-05T09:20:00Z] 📤 Bot`
  - Classify: Fast (<30s), Normal (30s-2min), Slow (2-5min), Very Slow (>5min)
- **First Response Latency**: Time from first user message to first agent response
- **Total Session Duration**: Time from first message to last message in a session

#### 2.2 Task Completion (任务完成度)

- **Completion Signals**: Look for markers indicating task success or failure:
  - ✅ Success: "完成", "成功", "done", "已创建", "已修复", "PR 已提交", checklist completion
  - ❌ Failure: "失败", "错误", "无法", "超时", "error", "failed", "timeout"
  - ⚠️ Partial: "部分完成", "需要手动", "跳过", "skipped"
- **Dialogue Rounds**: Count user-agent exchange rounds per task
  - Efficient: 1-3 rounds (single-turn or quick clarification)
  - Normal: 4-8 rounds (typical multi-step task)
  - Excessive: 9+ rounds (may indicate difficulty or misunderstanding)
- **Task Type Classification**: Categorize each session by task type:
  - `coding`: Code writing, debugging, refactoring
  - `analysis`: Research, investigation, data analysis
  - `ops`: Deployment, configuration, CI/CD
  - `communication`: Reporting, messaging, notifications
  - `review`: Code review, PR review, quality checks

#### 2.3 User Feedback Signals (用户满意度)

- **Positive Signals**: "谢谢", "好的", "完美", "不错", "很好", "thanks", "great", "perfect", "👍"
- **Negative Signals**: "不对", "错了", "重新", "再来", "不是这样", "改一下", "wrong", "retry", "again"
- **Neutral**: No explicit feedback (assume acceptable)
- **Repeat Requests**: Same task requested again within 24h (indicates previous failure)

#### 2.4 Tool Usage Efficiency (工具使用效率)

- **Tool Call Count**: Count tool invocations per session
  - Look for patterns like `Bash`, `Read`, `Glob`, `Grep`, `Write`, `Edit` in agent responses
- **Error Rate**: Tool calls that resulted in errors vs successful calls
  - Error indicators: "Error:", "failed", "exit code 1", "ENOENT", "permission denied"
- **Redundant Operations**: Repeated reads of the same file, redundant searches

#### 2.5 Error Patterns (错误率)

- **Session Errors**: Count sessions that ended with unresolved errors
- **Retry Rate**: Sessions requiring user to ask for retry
- **Timeout Indicators**: "超时", "timeout", "timed out", long gaps with no response
- **Self-Correction**: Agent detected and fixed its own errors (positive signal)

### Step 3: Aggregate and Compare

After extracting metrics from all sessions, aggregate by relevant dimensions:

#### By Model/Provider (if identifiable)

Some chat logs may contain model information in system messages or metadata. Extract when available:
- Model name (e.g., "claude-sonnet-4-20250514", "gpt-4o")
- Provider (e.g., "anthropic", "openai")

#### By Task Type

Group metrics by task category for fair comparison:
- Coding tasks should only be compared with other coding tasks
- Different task types have different baseline expectations

#### By Time Period

Compare current period with previous period:
- Week-over-week trends
- Identify improving or degrading areas

### Step 4: Generate Benchmark Report

Create a structured analysis report:

```markdown
## 🏁 Agent Framework 赛马报告

**报告时间**: [Timestamp]
**分析范围**: [Date range]
**分析会话数**: [Total sessions analyzed]
**涉及聊天数**: [Number of chats]

---

### 📊 总览指标

| 指标 | 数值 |
|------|------|
| 总会话数 | X |
| 成功完成 | X (X%) |
| 部分完成 | X (X%) |
| 失败/未完成 | X (X%) |
| 平均响应时间 | Xs |
| 平均对话轮次 | X |
| 用户满意度 | X% (正反馈比例) |

---

### 🏆 各任务类型表现

#### 💻 Coding 任务

| 指标 | 数值 |
|------|------|
| 会话数 | X |
| 成功率 | X% |
| 平均轮次 | X |
| 平均响应时间 | Xs |
| 用户正反馈 | X% |

**典型成功案例**:
> [Brief description of a well-handled coding task]

**典型问题案例**:
> [Brief description of a poorly-handled coding task]

#### 🔍 Analysis 任务

| 指标 | 数值 |
|------|------|
| 会话数 | X |
| 成功率 | X% |
| 平均轮次 | X |
| 平均响应时间 | Xs |
| 用户正反馈 | X% |

[... repeat for each task type ...]

---

### 📈 趋势分析 (对比上周)

| 指标 | 上周 | 本周 | 变化 |
|------|------|------|------|
| 成功率 | X% | X% | 📈/📉 X% |
| 平均响应时间 | Xs | Xs | 📈/📉 X% |
| 用户满意度 | X% | X% | 📈/📉 X% |

---

### 🎯 独特特性观察

> Agent 框架的独特特性无法通过数值赛马体现，以下是基于聊天记录的定性观察：

1. **[特性 1]**: [描述该框架在什么场景下表现突出]
2. **[特性 2]**: [描述另一个独特优势]
3. **[待改进]**: [描述发现的不足之处]

---

### 🔧 优化建议

1. **[建议 1]**: [具体改进方向] — 预期收益: [描述]
2. **[建议 2]**: [具体改进方向] — 预期收益: [描述]
3. **[建议 3]**: [具体改进方向] — 预期收益: [描述]

---

*报告由 Agent Benchmark Skill 自动生成 | 数据来源: 聊天记录分析*
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

## Analysis Guidelines

### Session Boundary Detection

A "session" is a continuous conversation about one topic. Detect session boundaries by:
- Time gap: >30 minutes between messages suggests a new session
- Topic change: User starts a completely new topic
- Explicit markers: "新任务", "next", or system-level separators

### Fair Comparison Rules

1. **Same task type only**: Don't compare coding tasks with analysis tasks
2. **Similar complexity**: Simple tasks (single question) vs complex tasks (multi-step) should be separated
3. **Statistical significance**: Only draw conclusions from 3+ sessions in a category
4. **Context matters**: Some chats may have known issues (network, config) — note these as caveats

### What Makes This Approach Different from Previous Attempts

| Previous Approach | This Approach |
|-------------------|---------------|
| PR #1461: Racing engine (+1,827 lines) | Zero new code in core |
| PR #1467: BaseAgent hooks (+589 lines) | Zero modifications to core |
| Structured metrics collection | LLM-based interpretation of natural language |
| Fixed ranking algorithm | AI-driven qualitative + quantitative analysis |
| Required framework changes | Uses existing chat logs as-is |

---

## Schedule Configuration

To enable automated weekly benchmarking, create a schedule file:

```yaml
---
name: "每周 Agent 赛马报告"
cron: "0 9 * * 1"  # Every Monday at 9:00 AM
enabled: true
blocking: true
chatId: "{your_target_chat_id}"
---

请使用 agent-benchmark skill 分析过去一周的聊天记录，生成 Agent Framework 赛马报告。

要求：
1. 读取 workspace/logs/ 目录下最近 7 天的所有聊天日志
2. 按任务类型分类分析：coding, analysis, ops, communication, review
3. 提取响应效率、任务完成度、用户满意度、工具使用效率、错误率等指标
4. 如有历史数据，进行趋势对比
5. 包含独特特性观察（数值无法体现的优势）
6. 使用 send_user_feedback 发送报告到当前 chatId
```

---

## Phase Roadmap

### Phase 1: Basic Report (Current)
- Analyze chat logs for quality metrics
- Generate structured benchmark reports
- Support scheduled automated execution

### Phase 2: Trend Tracking (Future)
- Store historical reports for week-over-week comparison
- Track improvement/degradation trends
- Alert on significant metric changes

### Phase 3: Actionable Insights (Future)
- Automatically suggest optimizations based on patterns
- Recommend model/provider changes for specific task types
- Integration with issue tracker for identified problems

---

## Checklist

- [ ] Read all chat log files from workspace/logs/
- [ ] Extracted metrics for each session (response time, completion, feedback, errors)
- [ ] Classified sessions by task type
- [ ] Aggregated metrics by task type and time period
- [ ] Identified unique qualitative characteristics
- [ ] Generated structured benchmark report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core code or BaseAgent (zero invasion principle)
- Generate reports with insufficient data (need 3+ sessions per category)
- Draw conclusions from single data points
- Use hardcoded ranking algorithms (let LLM analyze qualitatively)
- Compare across different task types unfairly
- Skip the send_user_feedback step
- Create schedules without user confirmation
