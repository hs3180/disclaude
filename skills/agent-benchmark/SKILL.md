---
name: agent-benchmark
description: Agent Framework benchmarking via chat history analysis - evaluates agent performance across chats, compares models/providers, and generates quality assessment reports. Use when user says keywords like "Agent评估", "模型对比", "赛马", "benchmark", "agent quality", "framework race".
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Agent Benchmark

Analyze chat histories to evaluate and compare agent performance across different models, providers, and configurations.

## When to Use This Skill

**Use this skill for:**
- Periodic agent quality assessment
- Comparing different models/providers performance
- Identifying weak spots in agent responses
- Generating benchmarking reports for framework "racing"

**Keywords that trigger this skill**: "Agent评估", "模型对比", "赛马", "benchmark", "agent quality", "framework race", "agent benchmark", "服务质量"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**LLM-driven analysis of real user interactions, zero code invasion.**

No modifications to agent framework code. The LLM analyzes chat logs directly to evaluate agent performance, identifying quality differences that pure metrics cannot capture (including unique framework characteristics).

---

## Analysis Process

### Step 1: Collect Chat Logs

Read all chat log files from the logs directory:

```
workspace/logs/
├── oc_chat1/
│   ├── 2026-05-06.md
│   └── 2026-05-07.md
├── oc_chat2/
│   └── 2026-05-07.md
└── ...
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Read recent log files (last 7 days recommended) with `Read`
3. If `workspace/logs/` is empty, try `workspace/chat/` as fallback

### Step 2: Extract Agent Interactions

For each chat log, identify agent-user interaction pairs:

1. **Find user requests**: Messages from users (📥 or User tag)
2. **Find agent responses**: Corresponding agent replies (📤 or Bot tag)
3. **Extract metadata**: Timestamps, model info (if visible in logs), tool calls

**Key indicators to look for:**
- Model/provider identifiers in log headers or metadata
- Agent type labels (e.g., "skillAgent", "primaryNode")
- Task types (coding, research, chat, scheduling)

### Step 3: Evaluate Performance Dimensions

Analyze each interaction across these dimensions:

#### 3.1 Response Efficiency (响应效率)
- Time between user request and agent response
- Number of turns needed to complete a task
- Single-turn resolution rate

**Rating scale:**
- 🟢 **Good**: Task completed in 1-2 turns
- 🟡 **Fair**: Task completed in 3-5 turns
- 🔴 **Poor**: Task required 5+ turns or was abandoned

#### 3.2 Task Completion (任务完成度)
- Was the user's request fully addressed?
- Did the user need to rephrase or retry?
- Were there follow-up corrections?

**Signals:**
- ✅ Complete: User confirmed satisfaction, no follow-up
- ⚠️ Partial: User asked follow-up clarification
- ❌ Failed: User expressed frustration, repeated request, or gave up

#### 3.3 User Satisfaction (用户满意度)
- Explicit positive feedback ("thanks", "great", "perfect")
- Explicit negative feedback ("wrong", "not what I wanted", "try again")
- Implicit signals (continued engagement vs. silence after response)

#### 3.4 Tool Usage Efficiency (工具使用效率)
- Number of tool calls relative to task complexity
- Unnecessary or redundant tool calls
- Tool call success rate

#### 3.5 Error Rate (错误率)
- Task failures, timeouts, crashes
- Incorrect outputs requiring correction
- Tool call failures

### Step 4: Compare Across Frameworks/Models

If multiple agent types or models are visible in the logs, compare them:

| Dimension | Agent A / Model A | Agent B / Model B |
|-----------|-------------------|-------------------|
| Avg response time | Xs | Ys |
| Task completion rate | X% | Y% |
| User satisfaction | X/5 | Y/5 |
| Error rate | X% | Y% |

**For unique characteristics** (无法量化的独特特性):
- Describe qualitatively what each agent excels at
- Note types of tasks where one clearly outperforms the other
- Identify scenarios where a specific model is preferred

### Step 5: Generate Benchmark Report

Create a structured report:

```markdown
## 🏁 Agent Framework 赛马评估报告

**评估时间**: [Timestamp]
**评估范围**: 最近 7 天
**分析聊天数**: [Number of chats]
**分析交互数**: [Number of interactions]

---

### 📊 整体表现概览

| 维度 | 评分 | 趋势 |
|------|------|------|
| 响应效率 | ⭐⭐⭐⭐ | → |
| 任务完成度 | ⭐⭐⭐⭐⭐ | ↑ |
| 用户满意度 | ⭐⭐⭐ | ↓ |
| 工具使用效率 | ⭐⭐⭐⭐ | → |
| 错误率 | ⭐⭐⭐⭐ (低错误) | ↑ |

---

### 🏆 各框架/模型对比

#### Model A: [Name]
- **交互数**: X 次
- **强项**: [What it does well]
- **弱项**: [Where it struggles]
- **最佳场景**: [When to use it]

#### Model B: [Name]
- **交互数**: Y 次
- **强项**: [What it does well]
- **弱项**: [Where it struggles]
- **最佳场景**: [When to use it]

---

### 🔍 典型案例分析

#### ✅ 优秀案例
> **用户**: [request]
> **Agent**: [response summary]
> **为什么好**: [analysis]

#### ❌ 失败案例
> **用户**: [request]
> **Agent**: [response summary]
> **为什么差**: [analysis]
> **建议改进**: [suggestion]

---

### 💡 改进建议

1. **[High Priority]**: [Suggestion]
2. **[Medium Priority]**: [Suggestion]
3. **[Low Priority]**: [Suggestion]

---

### 📋 下一步行动

- [ ] [Action item 1]
- [ ] [Action item 2]
```

### Step 6: Send Report

Send the report using `send_user_feedback`:

```
Use send_user_feedback with:
- content: [The benchmark report]
- format: "text"
- chatId: [The chatId from context]
```

---

## Analysis Guidelines

### What to Focus On
| Priority | Dimension | Why It Matters |
|----------|-----------|----------------|
| 🔴 High | Task completion | Core value proposition |
| 🔴 High | Error rate | Reliability indicator |
| 🟡 Medium | User satisfaction | Quality indicator |
| 🟡 Medium | Response efficiency | UX indicator |
| 🟢 Low | Tool usage | Optimization opportunity |

### What to Ignore
- Test/debug messages
- One-off issues with clear external causes (API down, etc.)
- Personal preference disagreements
- Interactions with fewer than 2 turns (too short to evaluate)

### Evaluation Biases to Avoid
- Do not favor verbose responses over concise ones
- Do not penalize agents for user-side confusion
- Do not compare interaction counts directly (different workloads)
- Consider task difficulty when comparing completion rates

---

## Example Analysis

### Input (Chat History Excerpt):

```
## [2026-05-10T09:15:00Z] 📥 User
帮我看看这个 PR 有没有问题 github.com/org/repo/pull/42

## [2026-05-10T09:15:45Z] 📤 Bot [claude-sonnet-4-20250514]
正在查看 PR #42...
[Uses gh pr view, reads code]
这个 PR 有 3 个问题需要关注：
1. 第 45 行存在 SQL 注入风险
2. 缺少错误处理
3. 测试用例不完整

## [2026-05-10T09:17:00Z] 📥 User
分析得很到位，帮我直接修复

## [2026-05-10T09:25:00Z] 📤 Bot [claude-sonnet-4-20250514]
已创建修复 PR #43，修复了以上所有问题。
```

### Output (Report Section):

```markdown
#### ✅ 优秀案例: PR Review + Fix
> **用户**: 帮我看看这个 PR 有没有问题
> **Agent**: 准确识别了 3 个问题（含安全漏洞），并在用户要求后直接修复
> **为什么好**: 一次交互完成分析+修复，准确识别了安全风险，主动发现未明说的问题
```

---

## Integration with Other Systems

### Current Phase: Report Only
- Analyze chat history
- Generate benchmarking report
- Send via `send_user_feedback`

### Future: Automated Optimization
- Route tasks to best-performing model automatically
- Adjust model selection based on task type
- Create skills for weak areas identified

---

## Checklist

- [ ] Read all chat log files from `workspace/logs/` (or `workspace/chat/`)
- [ ] Extracted agent-user interaction pairs
- [ ] Evaluated across all 5 dimensions
- [ ] Compared different models/frameworks (if applicable)
- [ ] Included qualitative analysis of unique characteristics
- [ ] Generated structured benchmark report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Modify any agent framework code to add metrics collection
- Create new modules or execution engines for benchmarking
- Compare agents based solely on token count or cost
- Include sensitive user data in reports
- Make ranking decisions — only present analysis, let humans decide
- Send reports to wrong chatId
