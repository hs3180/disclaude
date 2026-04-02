---
name: framework-race
description: Agent Framework performance comparison analyst - analyzes chat logs to compare different models/providers across key metrics. Use for framework benchmarking, model comparison, or when user says keywords like "模型对比", "框架赛马", "性能比较", "framework race", "model comparison", "benchmark". Triggered by scheduler for automated periodic execution.
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Framework Race

Analyze chat logs to compare different Agent models/providers and identify which framework performs best for specific task types.

## When to Use This Skill

**Use this skill for:**
- Periodic comparison of Agent framework performance
- Identifying which model excels at which task type
- Tracking performance trends across different providers
- Generating actionable benchmarking reports

**Keywords that trigger this skill**: "模型对比", "框架赛马", "性能比较", "framework race", "model comparison", "benchmark", "赛马"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero code invasion. Use LLM-based analysis of existing chat logs to evaluate Agent performance.**

This skill does NOT modify any core code. It reads chat history and metadata that already exists in the logging system, then uses LLM reasoning to:
- Extract performance signals from conversation patterns
- Compare different models/providers across task categories
- Identify each framework's strengths and weaknesses
- Generate actionable insights

---

## Analysis Dimensions

### 1. Response Efficiency (响应效率)
- Measure time gaps between user messages and bot responses
- Identify timeout or slow response patterns
- Compare response speed across different models

### 2. Task Completion Rate (任务完成度)
- Analyze conversation flow to determine if the task was completed
- Look for signs of success: user acknowledgment, task markers, positive feedback
- Look for signs of failure: repeated attempts, user frustration, task abandonment

### 3. User Satisfaction Signals (用户满意度)
- Positive signals: "谢谢", "好的", "完美", "可以了", thanks, perfect, great
- Negative signals: "不对", "错了", "重新来", "算了", wrong, retry, never mind
- Neutral indicators: follow-up questions, clarification requests

### 4. Tool Usage Efficiency (工具使用效率)
- Count tool calls per task (from metadata or message patterns)
- Identify unnecessary tool usage or redundant operations
- Compare tool efficiency across models

### 5. Error Rate (错误率)
- Count error messages, timeouts, retries, and failures
- Identify systematic error patterns per model
- Track error recovery success rate

---

## Analysis Process

### Step 1: Collect Chat Logs

Gather chat logs from the workspace:

1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. If `workspace/logs/` doesn't exist, skip execution
3. Focus on the analysis period (default: last 7 days for weekly report)

### Step 2: Read and Parse Logs

For each log file:
1. Read the full content with `Read` tool
2. Identify the model/provider used (from message metadata if available, or from context clues)
3. Extract conversation segments and task boundaries

### Step 3: Per-Task Analysis

For each identifiable task/conversation segment:

1. **Classify the task type**:
   - `coding`: Code writing, debugging, refactoring
   - `analysis`: Data analysis, research, investigation
   - `communication`: Message drafting, report generation
   - `operation`: CI/CD, deployment, infrastructure
   - `qa`: Testing, code review, quality assurance
   - `conversation`: General Q&A, discussion

2. **Evaluate performance** on each dimension:
   - Score response efficiency (fast/moderate/slow)
   - Determine task completion (completed/partial/failed)
   - Assess user satisfaction (positive/neutral/negative)
   - Count tool calls (if available in metadata)
   - Note any errors or retries

3. **Record metadata** (if available in logs):
   - Model name (e.g., claude-sonnet-4-20250514, glm-4, etc.)
   - Provider (e.g., anthropic, glm)
   - Elapsed time
   - Token usage
   - Cost

### Step 4: Aggregate and Compare

Group results by model/provider and task type:

1. Calculate per-model statistics:
   - Average response speed
   - Task completion rate (%)
   - User satisfaction score
   - Error rate
   - Average tool calls per task

2. Identify strengths:
   - Which model has the highest completion rate for coding tasks?
   - Which model responds fastest for analysis tasks?
   - Which model has the best user satisfaction for communication tasks?

3. Identify weaknesses:
   - Which model has the highest error rate?
   - Which task types cause the most failures across all models?
   - Are there systematic issues with specific models?

### Step 5: Generate Report

Create a structured comparison report:

```markdown
## 🏁 Agent Framework 赛马报告

**分析时间**: [Timestamp]
**分析范围**: [Date range]
**分析聊天数**: [Number of chats]
**任务总数**: [Total tasks analyzed]

---

### 📊 总览

| 模型 | 任务数 | 完成率 | 平均响应 | 满意度 | 错误率 |
|------|--------|--------|----------|--------|--------|
| model-a | X | XX% | Xs | X.X/5 | X% |
| model-b | X | XX% | Xs | X.X/5 | X% |

---

### 🏆 各维度最佳表现

| 维度 | 最佳模型 | 评分 | 说明 |
|------|----------|------|------|
| 整体完成率 | model-a | XX% | ... |
| 编码任务 | model-b | XX% | ... |
| 分析任务 | model-a | XX% | ... |
| 响应速度 | model-c | Xs | ... |
| 用户满意度 | model-a | X.X/5 | ... |

---

### 📈 按任务类型分析

#### 编码任务 (Coding)
| 模型 | 任务数 | 完成率 | 平均耗时 | 典型表现 |
|------|--------|--------|----------|----------|
| model-a | X | XX% | Xs | ... |
| model-b | X | XX% | Xs | ... |

**关键发现**:
- model-a 在复杂重构任务中表现更好
- model-b 在简单 bug 修复中速度更快

#### 分析任务 (Analysis)
[Same format as above]

#### 沟通任务 (Communication)
[Same format as above]

---

### 🔍 独特特性分析

> AI 驱动的定性分析：各模型独有的优势和特点

**model-a 特点**:
- 擅长处理复杂上下文理解
- 代码生成质量高，bug 率低
- 偶尔在理解隐含需求时需要额外提示

**model-b 特点**:
- 响应速度最快
- 擅长格式化输出和文档生成
- 在需要创意性回答时表现突出

---

### ⚠️ 问题发现

#### 问题 1: [问题描述]
- **影响模型**: model-a
- **出现频率**: X/X 任务
- **典型案例**:
  > [Chat excerpt showing the issue]
- **建议**: [Improvement suggestion]

---

### 📋 建议

1. **模型选择建议**: [Which model for which task type]
2. **配置优化**: [Any configuration improvements]
3. **持续监控**: [What to track going forward]
```

### Step 6: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Important Notes

### What This Skill Does NOT Do

- **Does NOT modify any core code** (zero invasion principle)
- **Does NOT embed metrics collection** into BaseAgent or any framework code
- **Does NOT create new modules or files** in the core packages
- **Does NOT require any code changes** to existing functionality

### Data Sources

This skill relies entirely on data that already exists in the chat logging system:
- `workspace/logs/` - Chat message logs with timestamps
- `AgentMessageMetadata` - Model, elapsed time, cost, tokens (if logged)
- Message direction indicators (user/bot)

### Analysis Methodology

The analysis is **AI-driven**, not rule-based:
- The LLM reads and interprets conversation patterns
- No hardcoded scoring algorithms
- Flexible evaluation that can adapt to different task types
- Qualitative insights alongside quantitative metrics

---

## Historical Context

This skill implements the "zero invasion" approach for Agent Framework comparison (Issue #1334), following the rejection of previous over-engineered approaches:
- PR #1461: Racing execution engine (rejected: +1827 lines, 6 new files)
- PR #1467: BaseAgent embedded metrics (rejected: high code invasiveness)

---

## Checklist

- [ ] Read all chat log files from workspace/logs/
- [ ] Identified model/provider for each conversation segment
- [ ] Classified tasks by type (coding, analysis, communication, etc.)
- [ ] Evaluated performance on all 5 dimensions
- [ ] Aggregated results by model and task type
- [ ] Identified unique strengths of each framework
- [ ] Generated structured comparison report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core code or framework files
- Embed metrics collection into BaseAgent
- Create new modules in core packages
- Send reports to wrong chatId
- Include sensitive information in reports
- Make definitive claims without sufficient data
- Use hardcoded ranking algorithms
