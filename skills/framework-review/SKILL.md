---
name: framework-review
description: Agent Framework quality review - analyzes chat histories to evaluate and compare different Agent frameworks/providers on response efficiency, task completion, user satisfaction, and error patterns. Use when user says keywords like "框架评估", "模型对比", "framework review", "race report", "服务质量报告".
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Framework Review

Analyze chat histories to evaluate and compare different Agent frameworks/providers, generating structured quality reports.

## When to Use This Skill

**Use this skill for:**
- Periodic Agent framework quality evaluation
- Comparing model/provider performance across chats
- Identifying framework-specific strengths and weaknesses
- Generating service quality reports
- Triggered by scheduler for automated weekly execution

**Keywords that trigger this skill**: "框架评估", "模型对比", "framework review", "race report", "服务质量报告", "agent benchmark"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based analysis to evaluate and compare Agent frameworks from real user interaction data.**

This skill performs zero-code-invasion quality evaluation by analyzing existing chat logs, without modifying any core agent code. The LLM reads conversation histories and extracts meaningful quality metrics across different providers/models.

---

## Analysis Process

### Step 1: Read All Chat Logs

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
3. Focus on recent logs (last 7 days recommended for weekly, 30 days for monthly)

### Step 2: Identify Agent Metadata

For each conversation, identify which agent framework/provider handled the interaction. Look for:

- **Provider information**: Keywords like `anthropic`, `openai`, `google`, etc. in system messages or metadata
- **Model information**: Model names like `claude-sonnet`, `gpt-4`, `gemini`, etc.
- **Agent type**: Skill agent, task agent, chat agent, etc.
- **Task type**: Coding, analysis, writing, Q&A, etc.

> **Note**: If provider/model information is not explicitly logged, categorize by conversation patterns and task complexity instead. The LLM can infer framework characteristics from response style and capability.

### Step 3: Evaluate Quality Dimensions

Analyze each conversation across these dimensions:

#### 3.1 Response Efficiency (响应效率)
- **Response speed**: Time between user message and agent response (from timestamps)
- **First-token latency**: How quickly the agent starts responding
- **Task resolution speed**: Total time from task start to completion
- **Scoring**: ⭐ (slow) to ⭐⭐⭐⭐⭐ (fast)

#### 3.2 Task Completion (任务完成度)
- **One-shot success**: Task completed in a single response
- **Multi-turn completion**: Required back-and-forth but eventually completed
- **Incomplete**: Task was abandoned or not resolved
- **Scoring**: ⭐ (mostly incomplete) to ⭐⭐⭐⭐⭐ (mostly one-shot)

#### 3.3 User Satisfaction (用户满意度)
- **Positive signals**: User says "thanks", "great", "perfect", "👍", etc.
- **Negative signals**: User says "wrong", "not what I wanted", "try again", "不对", "重做"
- **Neutral**: No explicit feedback
- **Scoring**: ⭐ (frequent corrections) to ⭐⭐⭐⭐⭐ (frequent praise)

#### 3.4 Tool Usage Efficiency (工具使用效率)
- **Appropriate tool calls**: Tools used were relevant and necessary
- **Over-invocation**: Too many redundant tool calls
- **Under-invocation**: Agent tried to answer without needed tools
- **Scoring**: ⭐ (wasteful) to ⭐⭐⭐⭐⭐ (efficient)

#### 3.5 Error Rate (错误率)
- **Tool failures**: Tool calls that returned errors
- **Task failures**: Tasks that failed entirely
- **Retry patterns**: Agent retrying the same failed approach
- **Scoring**: ⭐ (frequent errors) to ⭐⭐⭐⭐⭐ (rarely errors)

### Step 4: Unique Characteristics (独特特性)

**Important**: This is what differentiates this skill from simple metrics comparison.

For each framework/provider, identify qualitative strengths that cannot be captured by numbers:

- **Unique capabilities**: Things one framework does well that others can't
- **Interaction style**: How the agent communicates (verbose, concise, creative, analytical)
- **Domain expertise**: Areas where the framework excels
- **Special behaviors**: Notable patterns (e.g., always suggests tests, explains reasoning, asks clarifying questions)

### Step 5: Generate Comparison Report

Create a structured comparison report:

```markdown
## 🏁 Agent Framework 服务质量评估报告

**评估周期**: [Date Range]
**分析聊天数**: [Number of chats]
**分析消息数**: [Total messages]

---

### 📊 综合评分

| 维度 | Framework A (模型) | Framework B (模型) | 备注 |
|------|-------------------|-------------------|------|
| ⚡ 响应效率 | ⭐⭐⭐⭐ | ⭐⭐⭐ | |
| ✅ 任务完成度 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | |
| 😊 用户满意度 | ⭐⭐⭐⭐ | ⭐⭐⭐ | |
| 🔧 工具使用效率 | ⭐⭐⭐ | ⭐⭐⭐⭐ | |
| ❌ 错误率 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | 越高越好 |

---

### 🔍 详细分析

#### Framework A (e.g., Anthropic/Claude)

**样本数**: X 次对话

**优势**:
- [Specific strength with example]
- [Another strength]

**不足**:
- [Specific weakness with example]
- [Another weakness]

**典型交互**:
> [Quote a representative conversation excerpt]

#### Framework B (e.g., OpenAI/GPT)

**样本数**: X 次对话

**优势**:
- [Specific strength]

**不足**:
- [Specific weakness]

**典型交互**:
> [Quote a representative conversation excerpt]

---

### 🌟 独特特性

| Framework | 独特优势 | 适用场景 |
|-----------|---------|---------|
| Framework A | [描述无法被数字量化的独特能力] | [最适合的场景] |
| Framework B | [描述无法被数字量化的独特能力] | [最适合的场景] |

---

### 📈 趋势变化

[与上一期报告对比，如果有历史数据的话]

| 维度 | 变化 | 说明 |
|------|------|------|
| ... | ↑/↓/→ | ... |

---

### 💡 建议

1. **任务分配优化**: [基于分析结果，建议哪种任务分配给哪个框架]
2. **改进方向**: [各框架需要改进的方面]
3. **最佳实践**: [从高质量交互中总结的最佳实践]
```

### Step 6: Save Historical Data

Append the evaluation results to `workspace/data/framework-review-history.json`:

```json
{
  "history": [
    {
      "date": "2026-04-18T09:00:00.000Z",
      "period": "2026-04-11 to 2026-04-18",
      "chatCount": 15,
      "messageCount": 342,
      "frameworks": {
        "anthropic/claude-sonnet": {
          "samples": 10,
          "scores": {
            "responseEfficiency": 4,
            "taskCompletion": 5,
            "userSatisfaction": 4,
            "toolEfficiency": 3,
            "errorRate": 4
          }
        }
      },
      "highlights": ["Framework A excels at...", "Framework B improved in..."]
    }
  ]
}
```

If the file doesn't exist, create it. If it exists, append to the history array.

### Step 7: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Evaluation Guidelines

### What to Include

| Category | Indicators | Minimum Data |
|----------|------------|--------------|
| Response Efficiency | Timestamp gaps, first-token time | 5+ conversations |
| Task Completion | Final outcomes, conversation length | 5+ conversations |
| User Satisfaction | Feedback keywords, corrections | Any occurrence |
| Tool Usage | Tool call count, relevance | 3+ conversations |
| Error Rate | Error messages, retries | Any occurrence |

### What to Ignore

- Test/debug messages
- System notifications
- Incomplete conversations (< 2 exchanges)
- Conversations with only greetings/small talk

### When Data is Insufficient

If there are fewer than 5 analyzable conversations in the period:
- Report what is available with a note about sample size
- Suggest extending the evaluation period
- Still identify any clear patterns

---

## Historical Tracking

The `workspace/data/framework-review-history.json` file serves two purposes:

1. **Trend Analysis**: Compare current vs. previous evaluation periods to identify trends
2. **Sample Accumulation**: Over time, build a robust dataset for more reliable comparisons

When generating a report, always check if previous evaluations exist and include a trend comparison section.

---

## DO NOT

- Create schedules without user confirmation
- Send reports to wrong chatId
- Include sensitive user information in reports
- Make up data or metrics not supported by the chat logs
- Modify any core agent code
- Skip the send_user_feedback step
- Compare frameworks with insufficient data (< 3 samples each)
