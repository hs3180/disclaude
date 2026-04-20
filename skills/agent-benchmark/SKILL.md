---
name: agent-benchmark
description: Agent Framework performance benchmarking - analyzes chat logs to compare agent quality, response efficiency, task completion, and user satisfaction. Use when user says keywords like "Agent赛马", "框架比较", "agent benchmark", "性能对比", "benchmark", "agent performance", "服务质量评估".
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Agent Benchmark

Analyze chat history records to benchmark and compare Agent Framework performance, generating structured comparison reports.

## When to Use This Skill

**Use this skill for:**
- Weekly automated agent performance benchmarking
- Comparing quality across different agent configurations/providers/models
- Identifying strengths and unique capabilities of each agent
- Generating data-driven improvement recommendations

**Keywords that trigger this skill**: "Agent赛马", "框架比较", "agent benchmark", "性能对比", "benchmark", "agent performance", "服务质量评估", "agent race"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based analysis on chat history to evaluate agent performance. Zero code intrusion into the agent framework.**

Instead of embedding metrics collection into agent code, this skill reads existing chat logs and uses AI analysis to extract performance signals. This approach:
- Adds zero complexity to the agent framework
- Evaluates from the user experience perspective (not just execution metrics)
- Can capture qualitative differences that hard-coded metrics miss

---

## Analysis Process

### Step 1: Discover Chat Logs

Find all available chat history files:

```bash
# Check both possible log locations
ls workspace/chat/*.md 2>/dev/null
ls workspace/logs/**/*.md 2>/dev/null
```

Use `Glob` to enumerate files:
```
Glob: workspace/chat/*.md
Glob: workspace/logs/**/*.md
```

**Focus on recent logs** (last 7 days recommended for weekly reports, last 30 days for monthly reports).

### Step 2: Identify Agent Interactions

For each chat log, read and identify agent interaction sessions. Look for:

1. **Agent type/provider identification**: Check message metadata, headers, or content that indicates which agent framework or model was used
   - Look for patterns like `provider:`, `model:`, `agentType:` in message metadata
   - Identify agent responses by bot markers (e.g., `📤 Bot`, `🤖`, system-generated messages)

2. **Session boundaries**: Group messages into conversational sessions (user request → agent response → follow-ups)

3. **Task types**: Categorize tasks by type:
   - Coding tasks (code generation, debugging, refactoring)
   - Research tasks (information gathering, analysis)
   - Operational tasks (deployment, monitoring, maintenance)
   - Communication tasks (summarization, translation, Q&A)

### Step 3: Extract Performance Signals

Analyze each identified session for the following signals:

#### 3.1 Response Efficiency (响应效率)
- **Time to first response**: Gap between user message and agent first reply (from timestamps)
- **Total conversation rounds**: How many back-and-forth exchanges before task completion
- **Response length vs. value**: Whether responses are concise and valuable or verbose

**Extraction method**: Compare timestamps of consecutive user→bot message pairs.

#### 3.2 Task Completion (任务完成度)
- **Successful completion**: Did the agent fulfill the user's request?
- **Completion markers**: User saying "好的", "谢谢", "完成了", "可以了", or no follow-up corrections
- **Incomplete markers**: User saying "不对", "重来", "还是不行", or repeated requests for the same task
- **Partial completion**: Task achieved but with significant corrections needed

**Extraction method**: Analyze the last 2-3 messages in each session for satisfaction signals.

#### 3.3 User Satisfaction (用户满意度)
- **Positive signals**: "谢谢", "很好", "完美", "不错", "解决了", emoji thumbs up
- **Negative signals**: "不对", "错了", "改一下", "重来", "算了", frustration indicators
- **Neutral**: No explicit feedback, or task-oriented follow-up

**Extraction method**: Grep for satisfaction indicator patterns in user messages following agent responses.

#### 3.4 Tool Usage Efficiency (工具使用效率)
- **Tool calls**: How many tool invocations per task (Bash, Read, Write, etc.)
- **Relevance**: Were tool calls necessary and well-targeted?
- **Error rate**: How many tool calls resulted in errors or retries?

**Extraction method**: Count tool invocation patterns in agent responses.

#### 3.5 Error Patterns (错误模式)
- **Agent errors**: Task failures, timeouts, exceptions
- **User corrections**: User having to correct agent output
- **Retry patterns**: Agent retrying the same approach multiple times

**Extraction method**: Search for error-related keywords and correction patterns.

#### 3.6 Unique Capabilities (独特特性)
- Features or approaches that are unique to a specific agent configuration
- Tasks that one agent handles notably better than others
- Special capabilities that cannot be captured by quantitative metrics alone

**Extraction method**: Qualitative analysis of task approach and output quality.

### Step 4: Generate Benchmark Report

Create a structured comparison report:

```markdown
## 🏁 Agent Framework 性能赛马报告

**分析时间**: [Timestamp]
**分析范围**: 最近 [N] 天
**分析会话数**: [Number of sessions]
**涉及聊天**: [Number of chats]

---

### 📊 总体评分

| 维度 | Agent A (模型/配置) | Agent B (模型/配置) | Agent C (模型/配置) |
|------|---------------------|---------------------|---------------------|
| 响应效率 | ⭐⭐⭐⭐ (4/5) | ⭐⭐⭐ (3/5) | — |
| 任务完成度 | ⭐⭐⭐⭐⭐ (5/5) | ⭐⭐⭐⭐ (4/5) | — |
| 用户满意度 | ⭐⭐⭐⭐ (4/5) | ⭐⭐⭐ (3/5) | — |
| 工具使用效率 | ⭐⭐⭐⭐ (4/5) | ⭐⭐⭐⭐ (4/5) | — |
| 错误率 | ⭐⭐⭐⭐⭐ (低) | ⭐⭐⭐ (中等) | — |

> **综合评分**: Agent A > Agent B

---

### 🏆 各维度详情

#### 响应效率
- **Agent A**: 平均 [X] 轮对话完成任务, 首次响应 [特征]
- **Agent B**: 平均 [Y] 轮对话完成任务, 首次响应 [特征]
- **对比**: [Analysis]

#### 任务完成度
- **Agent A**: [X]% 成功率, [典型案例]
- **Agent B**: [Y]% 成功率, [典型案例]
- **对比**: [Analysis]

#### 用户满意度
- **Agent A**: [X] 次正面反馈 / [Y] 次负面反馈
- **Agent B**: [X] 次正面反馈 / [Y] 次负面反馈
- **对比**: [Analysis]

#### 错误模式
- **Agent A**: [常见错误及频率]
- **Agent B**: [常见错误及频率]

---

### 🌟 独特特性 (无法赛马的部分)

#### Agent A 的独特优势
- [Qualitative strength that's unique to this agent]
- [Example scenario]

#### Agent B 的独特优势
- [Qualitative strength that's unique to this agent]
- [Example scenario]

---

### 📋 改进建议

1. **Agent A**: [Recommendations based on weaknesses]
2. **Agent B**: [Recommendations based on weaknesses]

---

### 📈 趋势 (如有历史数据)

| 时间段 | Agent A 评分 | Agent B 评分 |
|--------|-------------|-------------|
| 本周 | [Score] | [Score] |
| 上周 | [Score] | [Score] |

---

*此报告由 agent-benchmark skill 自动生成*
```

### Step 5: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Evaluation Scoring Guide

### Response Efficiency (响应效率)
| Score | Criteria |
|-------|----------|
| 5 ⭐ | Task completed in 1-2 rounds, no unnecessary back-and-forth |
| 4 ⭐ | Task completed in 2-3 rounds, minimal clarification needed |
| 3 ⭐ | Task completed in 3-5 rounds, some clarification needed |
| 2 ⭐ | Task completed in 5+ rounds, significant clarification needed |
| 1 ⭐ | Task not completed or required excessive rounds |

### Task Completion (任务完成度)
| Score | Criteria |
|-------|----------|
| 5 ⭐ | Task fully completed, no corrections needed |
| 4 ⭐ | Task completed with minor corrections |
| 3 ⭐ | Task partially completed, some corrections needed |
| 2 ⭐ | Task completed but with major issues |
| 1 ⭐ | Task failed or abandoned |

### User Satisfaction (用户满意度)
| Score | Criteria |
|-------|----------|
| 5 ⭐ | Explicit positive feedback, user delighted |
| 4 ⭐ | Task accepted without corrections |
| 3 ⭐ | Neutral, task-oriented continuation |
| 2 ⭐ | Minor corrections or frustration signals |
| 1 ⭐ | Strong dissatisfaction, task abandoned |

---

## Important Notes

### What to Analyze
- ✅ Real user-agent interactions from chat logs
- ✅ Multiple sessions for statistical significance (minimum 3 sessions per agent)
- ✅ Both quantitative metrics and qualitative observations
- ✅ Unique strengths that each agent brings

### What to Skip
- ❌ Test messages or debug sessions
- ❌ Sessions with fewer than 2 message exchanges
- ❌ One-off tasks that don't represent typical usage
- ❌ Sensitive personal information (redact in reports)

### Handling Insufficient Data
If there isn't enough data to make meaningful comparisons:
- Report what data is available
- Note the insufficient data status
- Suggest waiting for more data before next analysis
- Do NOT fabricate scores or make unsupported claims

---

## Schedule Configuration

To enable periodic benchmarking, create a schedule file:

```markdown
---
name: "Agent 性能赛马"
cron: "0 9 * * 1"
enabled: true
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
---

请使用 agent-benchmark skill 分析最近一周的聊天记录，对比不同 Agent 的表现，生成赛马报告。

要求：
1. 读取 workspace/chat/ 或 workspace/logs/ 目录下的聊天记录
2. 重点关注最近 7 天的交互记录
3. 按响应效率、任务完成度、用户满意度、工具使用效率等维度评分
4. 特别注意每个 Agent 的独特特性（这是无法简单赛马的部分）
5. 使用 send_user_feedback 将报告发送到当前 chatId
```

---

## Checklist

- [ ] Read all chat log files from workspace/chat/ or workspace/logs/
- [ ] Identified agent interaction sessions across chats
- [ ] Extracted performance signals (efficiency, completion, satisfaction, errors)
- [ ] Noted unique capabilities of each agent
- [ ] Generated structured benchmark report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any agent framework code (this is an external analysis tool)
- Fabricate scores when data is insufficient
- Compare agents with only 1-2 sessions (statistically insignificant)
- Include sensitive personal information in reports
- Send reports to wrong chatId
- Skip the send_user_feedback step
