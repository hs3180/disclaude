---
name: agent-race-report
description: Agent Framework performance comparison specialist - analyzes chat logs to evaluate and compare Agent framework quality. Use for framework benchmarking, quality assessment, or when user says keywords like "赛马", "框架对比", "质量评估", "framework comparison", "agent race", "性能对比". Triggered by scheduler for automated weekly execution.
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Agent Race Report

Analyze chat logs to evaluate and compare Agent framework performance across multiple quality dimensions.

## When to Use This Skill

**Use this skill for:**
- Weekly automated Agent framework performance comparison
- Comparing quality of different Agent types (e.g., skillAgent, projectAgent, defaultAgent)
- Identifying which framework excels at specific task types
- Discovering unique capabilities of each framework
- Generating actionable improvement recommendations

**Keywords that trigger this skill**: "赛马", "框架对比", "质量评估", "framework comparison", "agent race", "性能对比", "framework benchmark"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Zero-code-invasion framework evaluation through chat log analysis.**

This skill does NOT modify any core code. It reads chat logs from `workspace/logs/` and uses LLM-based qualitative + quantitative analysis to compare Agent framework performance.

---

## Analysis Process

### Step 1: Read Chat Logs

Read all chat log files from the logs directory for the analysis period:

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
2. Filter to the analysis period (default: last 7 days)
3. Read each relevant log file with `Read` tool

### Step 2: Identify Agent Frameworks in Chats

From the chat logs, identify which Agent frameworks are being used. Look for indicators in messages:

- **Agent type markers**: Messages mentioning specific agent types (skillAgent, projectAgent, defaultAgent, etc.)
- **Skill invocations**: Which skills were triggered and by which agent
- **Tool usage patterns**: Different frameworks may use different tools
- **System prompt references**: Configuration or system messages revealing the framework

**Note**: If framework identification is not explicit in logs, group chats by behavior patterns:
- Chats with rich tool usage → likely advanced agent
- Chats with simple Q&A → likely basic agent
- Chats with scheduled task execution → likely scheduler agent

### Step 3: Evaluate Performance Dimensions

For each identified framework, evaluate across these **5 dimensions**:

#### 3.1 Response Efficiency
- **Response time**: Time between user message and bot first response (from timestamps)
- **Task completion speed**: Total time from task request to resolution
- **Multi-turn efficiency**: How many turns needed to complete a task

**Indicators**:
- Timestamps: `## [2026-03-06T10:30:00Z] 📥 User` → `## [2026-03-06T10:30:05Z] 📤 Bot`
- Fast response (good): < 10 seconds to first response
- Slow response (concern): > 30 seconds to first response

#### 3.2 Task Completion Quality
- **Resolution rate**: Percentage of tasks that were completed successfully
- **Accuracy**: Whether the output met user expectations
- **Completeness**: Whether all aspects of a request were addressed

**Indicators**:
- ✅ User satisfaction signals: "谢谢", "好的", "完美", "解决了"
- ❌ User dissatisfaction: "不对", "重做", "还是不行", "换一个"
- 🔄 Rework needed: Same task mentioned again after agent response

#### 3.3 User Feedback & Satisfaction
- **Explicit feedback**: Direct praise or complaints from users
- **Implicit feedback**: User returning to ask more (positive) vs abandoning (negative)
- **Manual corrections**: Times user had to correct agent output

**Indicators**:
- Positive: "很好", "太棒了", "thanks", task not revisited
- Negative: "不对", "应该是", "改成", repeated requests

#### 3.4 Tool Usage Efficiency
- **Tool call count**: Number of tool calls per task
- **Tool selection accuracy**: Whether the right tools were chosen
- **Error rate in tool usage**: Tool call failures or retries

**Indicators**:
- Efficient: Minimal tool calls with high success rate
- Inefficient: Many tool calls, retries, or failures

#### 3.5 Error Resilience
- **Error frequency**: How often errors occur
- **Recovery ability**: Whether the agent can self-correct after errors
- **Error types**: Timeouts, tool failures, misunderstanding, hallucination

**Indicators**:
- Error keywords: "失败", "错误", "无法", "error", "failed", "timeout"
- Recovery: Agent acknowledges error and provides alternative solution
- Failure: Agent gives up or loops

### Step 4: Compare & Rank

Create a structured comparison of identified frameworks:

```
For each framework, assign qualitative ratings:

| Dimension | Framework A | Framework B | Framework C |
|-----------|------------|------------|------------|
| Response Efficiency | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Task Completion | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| User Satisfaction | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| Tool Efficiency | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| Error Resilience | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
```

**IMPORTANT**: Also identify **unique capabilities** of each framework that cannot be compared directly — these are the "unique traits" mentioned in the original requirement.

### Step 5: Generate Report

Create a structured analysis report:

```markdown
## 🏁 Agent Framework 赛马报告

**分析时间**: [Timestamp]
**分析范围**: 最近 7 天
**聊天数量**: [Number of chats analyzed]
**消息数量**: [Total messages analyzed]

---

### 📊 框架综合对比

| 维度 | [Framework A] | [Framework B] | [Framework C] |
|------|:---:|:---:|:---:|
| 响应效率 | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 任务完成 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| 用户满意度 | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| 工具效率 | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| 错误韧性 | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| **综合** | **⭐⭐⭐⭐** | **⭐⭐⭐⭐** | **⭐⭐⭐⭐** |

---

### 🏆 最佳表现

| 奖项 | 框架 | 说明 |
|------|------|------|
| 🥇 最快响应 | [Framework] | 平均响应时间 X 秒 |
| 🎯 最高完成率 | [Framework] | Y% 任务一次完成 |
| 😊 用户最满意 | [Framework] | Z% 正面反馈率 |
| 🔧 工具使用最优 | [Framework] | 平均 A 次工具调用/任务 |
| 🛡️ 最稳定 | [Framework] | B% 错误恢复率 |

---

### ✨ 独特特性 (无法赛马的部分)

#### [Framework A] 独有优势
- [Unique capability 1]
- [Unique capability 2]

#### [Framework B] 独有优势
- [Unique capability 1]
- [Unique capability 2]

---

### 📈 关键数据

#### 响应时间分布
| 框架 | 平均 | P50 | P90 | 最快 | 最慢 |
|------|------|-----|-----|------|------|
| [Framework A] | Xs | Ys | Zs | As | Bs |

#### 任务完成率
| 框架 | 总任务 | 成功 | 需修改 | 失败 | 完成率 |
|------|--------|------|--------|------|--------|
| [Framework A] | N | M | K | J | R% |

---

### 🔍 详细分析

#### [Framework A]
**优势**:
- [Strength 1]
- [Strength 2]

**待改进**:
- [Weakness 1]
- [Weakness 2]

**典型案例**:
> [Representative conversation excerpt]

---

### 📋 改进建议

1. **[Framework A]**: [Specific improvement recommendation]
2. **[Framework B]**: [Specific improvement recommendation]
3. **全局建议**: [Cross-framework improvement]
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

## Analysis Guidelines

### What to Analyze

| Dimension | Data Source | Metrics |
|-----------|-------------|---------|
| Response Efficiency | Message timestamps | Time-to-first-response, task duration |
| Task Completion | Conversation outcomes | Resolution rate, rework rate |
| User Satisfaction | User feedback messages | Positive/negative sentiment ratio |
| Tool Efficiency | Tool call patterns | Calls per task, success rate |
| Error Resilience | Error messages & recovery | Error frequency, recovery rate |

### What to Ignore

- Test/debug messages
- System status messages
- Automated notifications (unless comparing automation quality)
- One-off issues not representative of framework behavior

### Handling Insufficient Data

If chat logs don't contain enough data for meaningful comparison:
- Note the limitation in the report
- Suggest increasing the analysis period
- Still provide analysis of available data
- Recommend logging improvements for future analysis

---

## Unique Traits Discovery

Beyond quantitative comparison, the report MUST identify **unique capabilities** that each framework possesses that others do not. These are the aspects that "cannot be raced":

- **Creative problem-solving**: Novel approaches to tasks
- **Context awareness**: Understanding of project-specific context
- **Proactive behavior**: Taking initiative beyond explicit requests
- **Multi-step planning**: Breaking complex tasks into logical steps
- **Adaptive communication**: Adjusting communication style to user
- **Cross-domain knowledge**: Applying knowledge from different domains

These traits should be highlighted with real examples from chat logs.

---

## Example Analysis

### Input (Chat History Excerpt):

```
## [2026-03-05T09:15:00Z] 📥 User
帮我看看今天有什么新的 GitHub issues

## [2026-03-05T09:15:03Z] 📤 Bot
正在检查 issues...（使用 gh issue list）

## [2026-03-05T09:15:08Z] 📤 Bot
找到了 5 个新 issues...

## [2026-03-06T09:10:00Z] 📥 User
帮我分析一下这个 PR 的代码质量

## [2026-03-06T09:10:05Z] 📤 Bot
让我先获取 PR 详情...（使用 gh pr view）
```

### Analysis:

- **Response time**: ~3-5 seconds (fast)
- **Tool usage**: gh CLI (appropriate)
- **Task completion**: Successful (issues listed, PR analyzed)
- **User satisfaction**: Positive (user continued asking questions)

---

## Integration Notes

### Phase 1 (Current): Report Only
- Analyze chat history
- Generate comparison report
- Send via `send_user_feedback`

### Phase 2 (Future): Trend Tracking
- Store historical reports for trend analysis
- Compare week-over-week performance changes
- Visualize improvement trajectories

### Phase 3 (Future): Automated Optimization
- Suggest specific configuration changes based on analysis
- Auto-tune agent parameters based on performance data
- Create issues for identified systemic problems

---

## Checklist

- [ ] Read all chat log files from workspace/logs/
- [ ] Identified Agent frameworks present in the logs
- [ ] Evaluated each framework across 5 dimensions
- [ ] Created comparative ranking table
- [ ] Identified unique traits of each framework
- [ ] Generated structured report with data tables
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any core framework code (this is analysis-only)
- Create schedules without user confirmation
- Send reports to wrong chatId
- Include sensitive user information in reports
- Fabricate metrics — only report what the data supports
- Skip the send_user_feedback step
- Compare frameworks when insufficient data exists without noting the limitation
