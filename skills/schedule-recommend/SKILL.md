---
name: schedule-recommend
description: Analyze user interaction patterns and recommend scheduled tasks. Use when user asks for task recommendations, wants to automate repetitive tasks, or says keywords like "推荐定时任务", "自动化", "定时推荐", "analyze patterns". Uses prompt-based analysis instead of complex modules.
allowed-tools: Read, Glob, Grep, Bash
---

# Schedule Recommendation

Analyze user interaction history and recommend scheduled tasks based on detected patterns.

## When to Use This Skill

**Use this skill for:**
- Analyzing user interaction patterns
- Recommending scheduled tasks for repetitive operations
- Helping users discover automation opportunities

**Keywords that trigger this skill**: "推荐定时任务", "定时推荐", "自动化分析", "schedule recommend", "analyze patterns", "自动定时"

## Core Principle

**Use prompt-based analysis, NOT complex program modules.**

The LLM should analyze patterns directly from message history, not through pre-built pattern detection algorithms.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Analysis Process

### Step 1: Read Message History

Read the chat history file for the current chat:

```
workspace/chat/{chatId}.md
```

**Note**: The chatId needs to be sanitized (replace special characters with underscores).

### Step 2: Analyze Patterns (Prompt-Based)

Analyze the message history to identify:

1. **Repetitive Tasks**: Tasks the user requests frequently
   - Same or similar requests appearing multiple times
   - Consistent task types (e.g., "check issues", "generate report", "summarize changes")

2. **Time Patterns**: When these tasks are typically requested
   - Daily patterns (e.g., "every morning around 9am")
   - Weekly patterns (e.g., "every Friday afternoon")
   - Hourly patterns (e.g., "every few hours")

3. **Task Suitability**: Whether the task is suitable for scheduling
   - Self-contained (doesn't require user input)
   - Has clear success criteria
   - Can run independently

### Step 3: Generate Recommendations

For each detected pattern, provide:

```markdown
## 💡 定时任务推荐

**任务类型**: [Task type]
**检测到的模式**: [Pattern description]
**建议时间**: [Recommended schedule]
**置信度**: [High/Medium/Low]
**出现次数**: [Count]

**建议的定时任务内容**:
"""
[The prompt that should be executed on schedule]
"""

[✅ 创建定时任务] [🔄 调整时间] [❌ 忽略]
```

---

## Pattern Detection Guidelines (Prompt-Based)

### What to Look For

1. **Frequency Threshold**: At least 3 occurrences of similar requests
2. **Time Consistency**: Requests happen at similar times
3. **Task Nature**: Tasks that are:
   - Information retrieval (status checks, summaries)
   - Report generation
   - Monitoring/alerting
   - Routine maintenance

### What to Avoid Recommending

- One-time tasks
- Tasks requiring user interaction
- Tasks dependent on specific context from previous conversation
- Tasks that need real-time decision making

---

## Example Analysis

### Input (Message History Excerpt):

```
## [2024-01-15T09:15:00Z] 📥 User
帮我看看今天有什么新的 GitHub issues

## [2024-01-16T09:20:00Z] 📥 User
查看今天的 GitHub issues

## [2024-01-17T09:10:00Z] 📥 User
检查新的 issues

## [2024-01-18T09:30:00Z] 📥 User
今天有什么新 issues 吗
```

### Output (Recommendation):

```markdown
## 💡 定时任务推荐

**任务类型**: GitHub Issues 检查
**检测到的模式**: 用户每天早上 9:00-9:30 之间查询新的 GitHub issues
**建议时间**: 每天 09:00
**置信度**: High
**出现次数**: 4 次

**建议的定时任务内容**:
"""
检查 hs3180/disclaude 仓库中所有 open 状态的 issues，排除已有 open PR 关联的 issues，按优先级排序后发送摘要报告。

报告格式：
- 高优先级 issues (bug/security)
- 中优先级 issues (feature/enhancement)
- 低优先级 issues (docs/chore)

使用 send_user_feedback 发送报告。
"""

[✅ 创建定时任务] [🔄 调整时间] [❌ 忽略]
```

---

## Creating the Schedule

If user confirms (✅ 创建定时任务), use the `/schedule` skill to create the scheduled task.

**Important**:
- Use the current chatId as the schedule scope
- Set appropriate cron expression based on detected pattern
- Include all necessary context in the schedule prompt

---

## Checklist

- [ ] Read message history from `workspace/chat/{chatId}.md`
- [ ] Identified at least 3 similar requests
- [ ] Detected time pattern (if any)
- [ ] Verified task is suitable for scheduling
- [ ] Generated clear recommendation with confidence level
- [ ] Ready to create schedule if user confirms

---

## DO NOT

- Recommend schedules for one-time tasks
- Create schedules without user confirmation
- Recommend tasks that require user interaction
- Use complex program modules for pattern detection (use prompt analysis)
- Create schedules from within this skill (delegate to /schedule skill)
