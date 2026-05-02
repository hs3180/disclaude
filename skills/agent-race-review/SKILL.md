---
name: agent-race-review
description: Agent performance comparison specialist - analyzes chat history to evaluate and compare different models/providers. Generates structured race reports with metrics. Use for agent comparison, performance analysis, or when user says keywords like "赛马", "模型对比", "性能分析", "agent race", "framework comparison".
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Agent Race Review

Analyze chat histories to evaluate and compare the performance of different Agent models/providers, generating structured comparison reports.

## When to Use This Skill

**Use this skill for:**
- Weekly automated agent performance review
- Comparing different model/provider performance across chats
- Identifying which models excel at specific task types
- Detecting quality degradation or improvement trends
- Generating agent framework comparison reports

**Keywords that trigger this skill**: "赛马", "模型对比", "性能分析", "agent race", "framework comparison", "模型评估", "agent performance"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based analysis to evaluate agent performance from chat history.**

The LLM analyzes message patterns directly from log files, evaluating:
- Response quality and efficiency across different models
- Task completion rates per provider/model
- User satisfaction signals per interaction
- Error patterns and recovery behavior
- Unique strengths of each model/provider

---

## Analysis Process

### Step 1: Read All Chat Logs

Read all chat log files from the logs directory:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-03-05.md
│   └── 2026-03-06.md
├── oc_chat2/
│   └── 2026-03-06.md
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Read each log file with `Read` tool
3. Focus on recent logs (last 7 days recommended for weekly review)

### Step 2: Extract Performance Metrics

For each chat session, analyze and extract the following metrics:

#### 2.1 Response Efficiency
- **Response Time**: Time between user message and agent's first response (estimate from timestamps)
- **Task Completion Speed**: How many turns to complete a task
- **Throughput**: Number of tasks completed per session

#### 2.2 Task Completion Quality
- **Success Rate**: Tasks completed successfully vs. abandoned/failed
- **Code Quality**: For coding tasks, did the code work? (look for user confirmations)
- **Requirement Fulfillment**: Did the response address all user requirements?

#### 2.3 User Satisfaction Signals
- **Positive**: Thank you messages, confirmations ("好的", "谢谢", "完美", "没问题")
- **Negative**: Corrections ("不对", "错了", "改一下"), repeated requests, frustration signals
- **Neutral**: Factual follow-up questions

#### 2.4 Error Patterns
- **Tool Failures**: Tool calls that returned errors
- **Timeout Issues**: Responses mentioning timeouts or HTTP errors
- **Retry Patterns**: Agent retrying the same operation multiple times
- **Hallucination Indicators**: User correcting factual errors

#### 2.5 Unique Characteristics
- **Creative Solutions**: Novel approaches to problems
- **Proactive Behavior**: Agent anticipating needs or suggesting improvements
- **Domain Strengths**: Tasks where a particular model clearly excels
- **Communication Style**: Clarity, detail level, formatting quality

### Step 3: Generate Comparison Report

Create a structured race report:

```markdown
## 🏁 Agent Framework 赛马报告

**分析时间**: [Timestamp]
**分析范围**: 最近 7 天
**聊天数量**: [Number of chats analyzed]
**消息数量**: [Total messages analyzed]

---

### 📊 模型/Provider 总体表现

| 模型/Provider | 任务数 | 成功率 | 平均轮次 | 用户满意度 | 综合评分 |
|---------------|--------|--------|----------|------------|----------|
| claude-sonnet | X | X% | X.X | X/5 | ⭐⭐⭐⭐ |
| glm-4 | X | X% | X.X | X/5 | ⭐⭐⭐ |

---

### 🏆 各维度最佳

| 维度 | 最佳模型 | 说明 |
|------|----------|------|
| 响应速度 | ... | ... |
| 代码质量 | ... | ... |
| 任务完成率 | ... | ... |
| 用户满意度 | ... | ... |
| 创造性 | ... | ... |

---

### 📈 详细分析

#### 响应效率
[详细分析各模型的响应速度和效率]

#### 任务完成度
[详细分析各模型的任务完成情况]

#### 错误模式
[各模型的常见错误类型和频率]

#### 独特特性 ⭐
[各模型独有的、无法直接比较的优势]

---

### 💡 建议

1. **最佳实践**: [基于数据推荐的模型使用策略]
2. **改进方向**: [需要改进的领域]
3. **观察项**: [需要持续关注的趋势]

---

### 📋 数据来源

- 分析了 [N] 个聊天会话
- 覆盖 [M] 个不同的用户交互
- 时间范围: [start] 至 [end]
```

### Step 4: Send Report

**CRITICAL**: Always send the report to the user using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Analysis Guidelines

### What to Look For

| Metric | How to Measure | Minimum Data Points |
|--------|---------------|-------------------|
| Response Time | Timestamp gaps between messages | 5+ interactions |
| Task Completion | Final message indicates success/failure | 3+ tasks |
| User Satisfaction | Thank you vs. correction ratio | 5+ interactions |
| Error Rate | Error messages per session | 3+ sessions |
| Creativity | Novel solutions, proactive suggestions | Qualitative |

### What to Ignore

- Test messages and debugging sessions
- One-off interactions without meaningful tasks
- System messages (not from real users)
- Sessions with fewer than 3 messages

### How to Identify Model/Provider

Look for model indicators in the chat logs:
- Agent name or configuration mentions
- Different response style patterns
- Explicit model references in system messages
- Log metadata or headers

If model/provider cannot be identified from logs, group by chat ID and analyze per-chat performance instead.

---

## Example Analysis

### Input (Chat History Excerpt):

```
## [2026-03-05T09:15:00Z] 📥 User
帮我写一个 TypeScript 函数，判断一个字符串是否是有效的邮箱地址

## [2026-03-05T09:15:30Z] 📤 Bot
这是一个验证邮箱地址的 TypeScript 函数...

## [2026-03-05T09:16:00Z] 📥 User
完美！能不能再加一个测试？

## [2026-03-05T09:17:00Z] 📤 Bot
当然，这是测试文件...

## [2026-03-05T09:17:30Z] 📥 User
谢谢！👍
```

### Output (Report Section):

```markdown
#### 任务完成度: 优秀 ✅
- 用户请求了功能 + 测试，两次请求均被满足
- 总计 2 轮对话完成任务
- 用户最后表达了满意（"谢谢！👍"）
```

---

## Quality Notes

### Fairness Principles
- Compare based on comparable task types
- Account for task complexity when evaluating speed
- Acknowledge that different models have different strengths
- Don't rank models solely on one dimension

### Handling Insufficient Data
- If fewer than 3 sessions analyzed: note data limitation
- If model/provider cannot be identified: report per-chat metrics
- If no meaningful comparison possible: provide individual session summaries

---

## DO NOT

- Create schedules without user confirmation
- Send reports to wrong chatId
- Include sensitive information in reports
- Make definitive rankings with insufficient data
- Skip the send_user_feedback step
- Modify any core agent code (this is analysis-only)
