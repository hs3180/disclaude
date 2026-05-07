---
name: agent-racing
description: Agent Framework Racing - analyzes chat history to evaluate and compare agent performance across different configurations. Use for agent benchmarking, framework comparison, quality assessment, or when user says keywords like "赛马", "agent评估", "framework对比", "服务质量", "agent racing", "benchmark", "framework comparison". Triggered by scheduler for periodic evaluation.
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Agent Framework Racing

Analyze chat history to evaluate and compare agent performance across different configurations/frameworks, identifying strengths, weaknesses, and unique characteristics.

## When to Use This Skill

**Use this skill for:**
- Periodic agent performance evaluation
- Comparing different agent configurations or frameworks
- Assessing overall service quality
- Identifying agent-specific strengths and weaknesses
- Discovering unique characteristics that can't be directly compared

**Keywords that trigger this skill**: "赛马", "agent评估", "framework对比", "服务质量", "agent racing", "benchmark", "framework comparison", "性能对比"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based analysis to evaluate and compare agent performance from real chat interactions.**

This is NOT a code-level benchmarking tool. Instead, it analyzes actual user-agent interactions from chat logs to derive qualitative and quantitative insights about agent performance. The approach is:

- **Zero code invasion**: No modification to core agent framework
- **AI-driven analysis**: The LLM interprets patterns and nuances that hardcoded metrics cannot capture
- **Real-world evaluation**: Based on actual user interactions, not synthetic benchmarks
- **Qualitative + Quantitative**: Captures both measurable metrics and subjective quality assessments

---

## Analysis Process

### Step 1: Read Chat Logs

Read all chat log files from the logs directory:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-03-05.md
│   ├── 2026-03-06.md
│   └── ...
├── oc_chat2/
│   └── 2026-03-06.md
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Read each log file with `Read` tool
3. Focus on recent logs (last 7 days recommended, or specify period)

### Step 2: Identify Agent Interactions

For each chat log, identify distinct agent interactions (conversations):

An **interaction** is a sequence of messages between user and agent, from user's initial request to task completion or conversation end.

For each interaction, extract:
- **Timestamps**: Start and end time
- **Agent configuration**: Model name, provider (if visible in logs)
- **Task type**: What kind of task (coding, analysis, research, chat, etc.)
- **Interaction rounds**: Number of back-and-forth exchanges
- **Tools used**: Which tools the agent invoked
- **Outcome**: Success, partial, failure, or abandoned

### Step 3: Evaluate Performance Metrics

Analyze the identified interactions across five key dimensions:

#### 3.1 Response Efficiency (响应效率)
- **First response time**: How quickly the agent responds to the initial request
- **Total interaction duration**: Time from first user message to task completion
- **Rounds to completion**: How many back-and-forth exchanges needed
- **Pattern to detect**:
  - Fast: Task completed in 1-2 rounds
  - Medium: 3-5 rounds
  - Slow: 6+ rounds or multiple sessions

#### 3.2 Task Completion (任务完成度)
- **Completion rate**: Percentage of tasks fully completed vs partially or failed
- **Success indicators**: User says "thanks", "done", "good", task appears resolved
- **Failure indicators**: User says "不对", "还是不行", "算了", or re-asks the same question
- **Partial completion**: Task partially done but needs manual follow-up

#### 3.3 User Satisfaction (用户满意度)
- **Positive signals**: "谢谢", "好的", "太棒了", "完美", "解决了", thumbs up
- **Negative signals**: "不对", "重做", "不是这个意思", "算了我自己来", frustration
- **Neutral**: Task completed without explicit feedback
- **Correction patterns**: How often users need to correct the agent's output

#### 3.4 Tool Usage Efficiency (工具使用效率)
- **Appropriate tool selection**: Did the agent use the right tools for the task?
- **Tool call efficiency**: Minimal necessary tool calls vs excessive exploration
- **Error recovery**: How well the agent handles tool errors
- **Pattern to detect**:
  - Efficient: 1-3 targeted tool calls
  - Moderate: 4-8 tool calls with some exploration
  - Excessive: 9+ tool calls or repeated failed attempts

#### 3.5 Error Rate (错误率)
- **Task failures**: Tasks that could not be completed
- **Retry patterns**: Same approach tried multiple times
- **Error types**: Build failures, test failures, incorrect code, misunderstanding
- **Recovery rate**: How often the agent recovers from errors

### Step 4: Identify Unique Characteristics

Beyond comparable metrics, identify **unique characteristics** of each agent configuration that cannot be directly compared:

- **Special strengths**: Things one agent excels at that others don't
- **Creative solutions**: Novel approaches to problems
- **Communication style**: How the agent explains and presents information
- **Proactive behavior**: Does the agent anticipate needs or only respond to explicit requests?
- **Domain expertise**: Areas where the agent shows deep understanding

### Step 5: Generate Comparison Report

Create a structured evaluation report:

```markdown
## 🏁 Agent Framework 赛马评估报告

**评估时间**: [Timestamp]
**评估范围**: 最近 7 天
**分析聊天数**: [Number of chats]
**分析交互数**: [Total interactions analyzed]

---

### 📊 总体性能概览

| 维度 | 评分 | 趋势 |
|------|------|------|
| 响应效率 | ⭐⭐⭐⭐ (4/5) | ↗️ 改善中 |
| 任务完成度 | ⭐⭐⭐⭐⭐ (5/5) | → 稳定 |
| 用户满意度 | ⭐⭐⭐⭐ (4/5) | ↗️ 改善中 |
| 工具使用效率 | ⭐⭐⭐ (3/5) | ↘️ 需关注 |
| 错误率 | ⭐⭐⭐⭐ (4/5) | → 稳定 |

---

### 📈 量化指标

#### 响应效率
- **平均首次响应时间**: X 秒
- **平均任务完成时间**: X 分钟
- **平均交互轮次**: X 轮

#### 任务完成度
- **完成率**: X% (成功 X / 部分完成 X / 失败 X)
- **按任务类型**:
  - 编码任务: X% 完成率
  - 分析任务: X% 完成率
  - 研究任务: X% 完成率

#### 用户满意度
- **正面反馈率**: X%
- **修正次数**: X 次
- **用户主动放弃次数**: X 次

#### 错误分析
- **总错误数**: X 次
- **自动恢复率**: X%
- **常见错误类型**: [List top 3]

---

### 🌟 独特特性

#### Agent 优势
1. **[优势 1]**: [描述具体场景和表现]
2. **[优势 2]**: [描述具体场景和表现]

#### 改进空间
1. **[问题 1]**: [描述问题及建议改进方向]
2. **[问题 2]**: [描述问题及建议改进方向]

---

### 🎯 关键发现

#### ✅ 做得好的方面
- [Finding 1]
- [Finding 2]

#### ⚠️ 需要改进的方面
- [Finding 1]
- [Finding 2]

#### 💡 建议的行动
1. **高优先级**: [Action with expected impact]
2. **中优先级**: [Action with expected impact]
3. **低优先级**: [Action with expected impact]

---

### 📋 详细案例

#### 优秀案例
> **[案例标题]** — [Chat ID], [Date]
> [Brief description of excellent performance]

#### 需改进案例
> **[案例标题]** — [Chat ID], [Date]
> [Brief description of what went wrong and how to improve]
```

### Step 6: Send Report

**CRITICAL**: Always send the report to the user using `send_user_feedback`.

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
| ⭐⭐⭐⭐⭐ (5/5) | Most tasks completed in 1-2 rounds, first response within seconds |
| ⭐⭐⭐⭐ (4/5) | Most tasks completed in 2-3 rounds, occasional follow-up needed |
| ⭐⭐⭐ (3/5) | Tasks need 3-5 rounds, some back-and-forth expected |
| ⭐⭐ (2/5) | Tasks often need 6+ rounds or multiple sessions |
| ⭐ (1/5) | Extremely slow, tasks frequently abandoned due to long duration |

### Task Completion (任务完成度)

| Score | Criteria |
|-------|----------|
| ⭐⭐⭐⭐⭐ (5/5) | >90% tasks fully completed without user intervention |
| ⭐⭐⭐⭐ (4/5) | 80-90% tasks completed, minor follow-up sometimes needed |
| ⭐⭐⭐ (3/5) | 60-80% tasks completed, moderate manual intervention needed |
| ⭐⭐ (2/5) | 40-60% tasks completed, significant manual work required |
| ⭐ (1/5) | <40% tasks completed, user often has to redo work |

### User Satisfaction (用户满意度)

| Score | Criteria |
|-------|----------|
| ⭐⭐⭐⭐⭐ (5/5) | Frequent positive feedback, users express satisfaction |
| ⭐⭐⭐⭐ (4/5) | Mostly positive, occasional corrections |
| ⭐⭐⭐ (3/5) | Mixed feedback, equal positive and negative signals |
| ⭐⭐ (2/5) | More negative than positive, users frequently frustrated |
| ⭐ (1/5) | Predominantly negative, users often give up |

### Tool Usage Efficiency (工具使用效率)

| Score | Criteria |
|-------|----------|
| ⭐⭐⭐⭐⭐ (5/5) | Minimal targeted tool calls, right tool first time |
| ⭐⭐⭐⭐ (4/5) | Efficient with occasional exploration |
| ⭐⭐⭐ (3/5) | Moderate exploration, some unnecessary calls |
| ⭐⭐ (2/5) | Excessive tool calls, repeated failed attempts |
| ⭐ (1/5) | Tool calls rarely accomplish intended purpose |

### Error Rate (错误率)

| Score | Criteria |
|-------|----------|
| ⭐⭐⭐⭐⭐ (5/5) | <5% error rate, errors self-corrected |
| ⭐⭐⭐⭐ (4/5) | 5-10% error rate, most errors recovered |
| ⭐⭐⭐ (3/5) | 10-20% error rate, some errors need user intervention |
| ⭐⭐ (2/5) | 20-35% error rate, frequent failures |
| ⭐ (1/5) | >35% error rate, tasks frequently fail |

---

## Analysis Guidelines

### What to Focus On

| Pattern Type | Indicators | Analysis Approach |
|--------------|------------|-------------------|
| Response Speed | Timestamp gaps between messages | Calculate average time-to-first-response |
| Task Success | User's final message sentiment | Track completion vs abandonment rate |
| User Corrections | "不对", "应该是", "改成" | Count corrections per interaction |
| Tool Efficiency | Tool call patterns in logs | Assess tool selection appropriateness |
| Error Recovery | Retry patterns, error messages | Calculate recovery success rate |
| Unique Strengths | Novel approaches, proactive behavior | Qualitative description with examples |

### What to Ignore

- Test/debug messages
- System notifications
- One-off issues with clear external causes (network errors, API downtime)
- Messages from scheduled tasks (focus on real user interactions)

### Sample Size Guidelines

| Metric | Minimum Sample | Reliable Sample |
|--------|---------------|-----------------|
| Completion Rate | 10 interactions | 30+ interactions |
| Response Time | 5 interactions | 20+ interactions |
| Satisfaction Score | 10 interactions | 50+ interactions |
| Error Rate | 20 interactions | 50+ interactions |

If sample size is below minimum, note this in the report:
```
⚠️ 样本量不足: 仅分析了 X 次交互，结论仅供参考。建议积累更多数据后再次评估。
```

---

## Integration with Scheduled Tasks

This skill is designed to work as a periodic scheduled task. To set up:

### Schedule Configuration

```yaml
# Example schedule file: workspace/schedules/agent-racing-weekly.md
---
name: Agent Racing 周报
cron: "0 10 * * 1"  # Every Monday 10:00
enabled: true
blocking: true
chatId: oc_your_chat_id
createdAt: 2026-01-01T00:00:00.000Z
---

执行 Agent Racing 评估：
1. 分析最近 7 天所有聊天的交互记录
2. 按照五个维度评估 Agent 性能
3. 识别独特特性和改进空间
4. 生成结构化对比报告
5. 通过 send_user_feedback 发送报告
```

### Important Notes for Scheduled Execution

- **Self-contained**: The skill reads all context from log files, no prior state needed
- **No side effects**: Only reads logs and generates reports, no modifications
- **Anti-recursion**: Does NOT create or modify other scheduled tasks
- **Idempotent**: Running multiple times produces fresh analysis each time

---

## Example Analysis

### Input (Chat Log Excerpt):

```markdown
## [2026-05-01T09:15:00Z] 📥 User
帮我修复 issue #42 的 bug

## [2026-05-01T09:15:30Z] 📤 Bot
好的，让我先看看 issue #42 的详情...
[Uses Bash: gh issue view 42]

## [2026-05-01T09:16:45Z] 📤 Bot
了解了，这是一个登录验证的 bug。让我查看相关代码...
[Uses Read: src/auth/login.ts]
[Uses Grep: pattern="validatePassword"]

## [2026-05-01T09:18:20Z] 📤 Bot
找到问题了！密码验证函数没有处理空值情况。我来修复它。
[Uses Edit: src/auth/login.ts]

## [2026-05-01T09:19:00Z] 📤 Bot
修复完成，已创建 PR #43。

## [2026-05-01T09:20:00Z] 📥 User
太快了，谢谢！
```

### Analysis:

| Dimension | Assessment |
|-----------|------------|
| Response Speed | ⭐⭐⭐⭐⭐ First response in 30s, total 4 minutes |
| Task Completion | ⭐⭐⭐⭐⭐ Bug fixed and PR created |
| User Satisfaction | ⭐⭐⭐⭐⭐ Positive feedback ("太快了，谢谢！") |
| Tool Efficiency | ⭐⭐⭐⭐ 3 targeted tool calls |
| Error Rate | ⭐⭐⭐⭐⭐ No errors |

---

## Checklist

- [ ] Read all chat log files from workspace/logs/
- [ ] Identified distinct agent interactions
- [ ] Evaluated all 5 performance dimensions
- [ ] Identified unique characteristics
- [ ] Noted sample size adequacy
- [ ] Generated structured report with scoring
- [ ] Included specific case examples (positive and negative)
- [ ] Provided actionable improvement recommendations
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core agent code
- Create new scheduled tasks
- Send reports to wrong chatId
- Include sensitive personal information in reports
- Draw conclusions from insufficient sample sizes without disclaimer
- Skip the send_user_feedback step
- Compare agents based on single interactions (need statistical significance)
- Ignore context when evaluating (e.g., complex tasks naturally take longer)
