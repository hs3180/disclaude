---
name: agent-race
description: Agent performance analysis specialist - analyzes chat history to evaluate and compare agent service quality across different types and configurations. Use when user says keywords like "Agent 赛马", "性能对比", "服务质量", "agent race", "performance comparison", "benchmark", "质量评估".
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Agent Race - Agent Performance Analysis

Analyze chat histories to evaluate and compare agent service quality, identifying strengths, weaknesses, and improvement opportunities across different agent types and configurations.

## When to Use This Skill

**Use this skill for:**
- Periodic agent quality assessment
- Comparing performance across different agent types (skill, schedule, chat)
- Identifying common failure patterns and error rates
- Generating actionable improvement recommendations
- Tracking quality trends over time

**Keywords that trigger this skill**: "Agent 赛马", "性能对比", "服务质量", "agent race", "performance comparison", "benchmark", "质量评估", "赛马报告"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**LLM-driven analysis of chat records, zero code intrusion.**

This skill does NOT modify any agent code. It reads existing chat logs and applies LLM-based analysis to extract quality metrics and generate comparison reports.

---

## Analysis Process

### Step 1: Read Chat Logs

Read all chat log files from the logs directory:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-04-15.md
│   └── 2026-04-16.md
├── oc_chat2/
│   └── 2026-04-16.md
└── ...
```

Also check for per-chat history files:

```
workspace/chat/
├── oc_chat1.md
├── oc_chat2.md
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md` and `workspace/chat/*.md`
2. Read each log file with `Read` tool
3. Focus on the analysis period (default: last 7 days)

### Step 2: Extract Metrics

Analyze the chat history to extract the following quality dimensions:

#### 2.1 Response Efficiency
- **Response time**: Time between user message and agent reply (from timestamps)
- **First-response time**: How quickly the agent starts responding
- **Resolution time**: How long until the task is fully resolved

#### 2.2 Task Completion
- **Completion rate**: Percentage of tasks that reach a clear conclusion
- **Follow-up rate**: How often users need to ask follow-up questions
- **Abandonment signals**: Users saying "算了", "不用了", switching topics

#### 2.3 User Feedback Signals
- **Positive signals**: "谢谢", "好的", "完美", "解决了", thumbs up
- **Negative signals**: "不对", "重试", "没理解", "应该是", "改一下"
- **Frustration signals**: Repeated corrections, same question asked differently, "为什么不行"

#### 2.4 Tool Usage Efficiency
- **Tool call count**: Number of tool calls per task
- **Tool success rate**: Percentage of tool calls that contributed to the solution
- **Redundant calls**: Unnecessary repeated tool calls

#### 2.5 Error Rate
- **Tool errors**: Failed tool calls, permission errors
- **Logic errors**: Wrong code, incorrect analysis
- **Timeout/retry**: Tasks that needed multiple attempts

### Step 3: Categorize by Agent Context

When analyzing chat logs, identify the agent context for each interaction:

| Dimension | Possible Values | How to Identify |
|-----------|----------------|-----------------|
| **Channel type** | Group chat, DM, Schedule | From chat metadata or log file location |
| **Task type** | Coding, Analysis, Q&A, Creative | From the nature of the user request |
| **Complexity** | Simple, Medium, Complex | From number of tool calls, message rounds |
| **Outcome** | Success, Partial, Failed | From whether the task was completed |

### Step 4: Generate Report

Create a structured performance analysis report:

```markdown
## 🏁 Agent 赛马报告 (Agent Race Report)

**分析周期**: [Date range]
**分析范围**: [Number of chats] 个聊天, [Number of messages] 条消息
**生成时间**: [Timestamp]

---

### 📊 整体质量概览

| 指标 | 数值 | 趋势 |
|------|------|------|
| 任务完成率 | X% | ↑/↓/→ |
| 平均响应轮次 | X 轮 | ↑/↓/→ |
| 用户满意信号 | X% | ↑/↓/→ |
| 工具调用成功率 | X% | ↑/↓/→ |
| 错误率 | X% | ↑/↓/→ |

---

### 🔍 按任务类型分析

#### Coding 任务
- **样本数**: X 次
- **完成率**: X%
- **常见问题**: [Top issues]
- **优势**: [What went well]

#### Analysis 任务
...

#### Q&A 任务
...

---

### 🔴 高频问题 (需关注)

#### 问题 1: [Issue Title]
- **出现次数**: X 次
- **影响范围**: [Which chats]
- **典型场景**:
  > [Example from chat log]

- **建议改进**:
  - [ ] [Action item 1]
  - [ ] [Action item 2]

---

### 🟢 优势表现

- [List of things working well, with examples from chat logs]

---

### 📈 趋势分析 (如果有历史数据)

与上一周期对比:
| 指标 | 上期 | 本期 | 变化 |
|------|------|------|------|
| 完成率 | X% | Y% | +Z% |

---

### 🏆 本期亮点

1. **最佳交互**: [Describe the best agent interaction]
2. **最佳恢复**: [Describe how agent recovered from an error]
3. **独特优势**: [Something only this agent configuration does well]

---

### 📋 建议的下一步

1. **立即行动**: [High priority improvements]
2. **计划中**: [Medium priority improvements]
3. **观察**: [Things to monitor]
```

### Step 5: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

### Step 6: Save Analysis History

Append analysis results to `workspace/data/agent-race-history.json`:

```json
{
  "history": [
    {
      "date": "2026-04-23T03:00:00.000Z",
      "period": "2026-04-16 to 2026-04-23",
      "chatsAnalyzed": 5,
      "messagesAnalyzed": 150,
      "metrics": {
        "completionRate": 0.85,
        "avgResponseRounds": 3.2,
        "satisfactionRate": 0.78,
        "errorRate": 0.12
      },
      "topIssues": ["Issue 1", "Issue 2"]
    }
  ]
}
```

This history enables trend analysis in future reports.

---

## Analysis Guidelines

### What to Focus On

| Priority | What to Look For | Minimum Occurrences |
|----------|-----------------|---------------------|
| 🔴 High | Repeated failures, user frustration | 2+ |
| 🟡 Medium | Suboptimal patterns, missed opportunities | 3+ |
| 🟢 Low | Nice-to-have improvements | 5+ |

### What to Ignore

- One-off issues that don't repeat
- Issues caused by external factors (API outages, network errors)
- Test/debug messages
- Personal preferences that don't indicate quality problems

### Fairness Rules

- Don't compare agents on tasks they weren't designed for
- Acknowledge unique capabilities that can't be compared
- Consider task complexity when comparing completion rates
- Context matters: a "simple" task in a complex domain may still be impressive

---

## Comparison Dimensions

When comparing different interactions, consider these dimensions:

### Quantitative (measurable from logs)
- Response speed (timestamps)
- Task completion rate
- Tool usage efficiency
- Error frequency
- Message round count

### Qualitative (LLM-judged)
- Task understanding accuracy
- Code/solution quality
- Communication clarity
- Error recovery ability
- Creativity in problem-solving

### Unique capabilities (cannot be compared)
- Framework-specific features
- Integration depth with specific tools
- Domain-specific optimizations

---

## Example Analysis

### Input (Chat Log Excerpt):

```
## [2026-04-20T09:15:00Z] 📥 User
帮我修复 TypeScript 编译错误

## [2026-04-20T09:15:30Z] 📤 Bot
我来检查编译错误。先运行 tsc 看看具体报错...

## [2026-04-20T09:16:00Z] 📤 Bot
发现 3 个类型错误：
1. src/utils/helpers.ts:45 - 类型不匹配
2. src/api/handler.ts:12 - 缺少返回类型
3. src/models/user.ts:78 - 属性不存在

正在修复...

## [2026-04-20T09:18:00Z] 📤 Bot
已修复全部 3 个错误，编译通过。

## [2026-04-20T09:18:30Z] 📥 User
谢谢，搞定了！
```

### Extracted Metrics:
- **Task type**: Coding
- **Complexity**: Medium (3 errors to fix)
- **Response time**: ~30 seconds to first action
- **Resolution time**: ~3 minutes
- **Tool calls**: 2 (tsc check + file edits)
- **Outcome**: Success (positive user feedback "搞定了")
- **Rounds**: 3 messages from agent

---

## Schedule Configuration

To enable periodic analysis, create a schedule file:

```markdown
---
name: "Agent Race 周报"
cron: "0 9 * * 1"
enabled: true
blocking: true
chatId: "{target_chat_id}"
createdAt: "2026-04-23T00:00:00.000Z"
---

请使用 agent-race skill 分析过去一周的聊天记录，生成 Agent 赛马报告。

要求：
1. 读取 workspace/logs/ 和 workspace/chat/ 目录下的聊天记录
2. 重点分析过去 7 天的交互数据
3. 从响应效率、任务完成度、用户反馈、工具使用、错误率五个维度评估
4. 生成结构化的对比报告
5. 使用 send_user_feedback 发送到当前 chatId
```

---

## Checklist

- [ ] Read all chat log files from `workspace/logs/` and `workspace/chat/`
- [ ] Extracted metrics from all five dimensions
- [ ] Identified performance patterns across different task types
- [ ] Generated structured comparison report
- [ ] Saved analysis results to `workspace/data/agent-race-history.json`
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any agent source code
- Add instrumentation or logging to existing code
- Compare agents on tasks outside their designed scope
- Generate reports without concrete data from chat logs
- Skip the send_user_feedback step
- Create new modules or files outside the skill directory
