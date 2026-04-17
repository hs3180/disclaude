---
name: daily-chat-review
description: Daily chat history analysis specialist - reviews all chat logs, identifies repetitive issues, and generates improvement reports. Use for daily review tasks, pattern analysis, or when user says keywords like "每日回顾", "聊天分析", "识别问题", "daily review", "pattern analysis". Triggered by scheduler for automated daily execution.
allowed-tools: Read, Glob, Bash, send_user_feedback
---

# Daily Chat Review

Review all chat histories, identify repetitive issues, and generate improvement reports.

## When to Use This Skill

**Use this skill for:**
- Daily automated chat history review
- Identifying repetitive user requests
- Detecting common issues and errors
- Generating improvement recommendations
- Triggering offline discussions for important issues

**Keywords that trigger this skill**: "每日回顾", "聊天分析", "识别问题", "daily review", "pattern analysis", "chat history"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based analysis to identify patterns from chat history.**

The LLM analyzes message patterns directly from log files, identifying:
- Repeated user requests (same question asked multiple times)
- Manual corrections (user repeatedly correcting agent's output)
- Error patterns (similar errors occurring frequently)
- Improvement opportunities (tasks that could be automated)

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
3. Focus on recent logs (last 7 days recommended)

### Step 2: Analyze Patterns

Analyze the chat history to identify:

1. **Repetitive User Requests**
   - Same or similar questions asked multiple times
   - Pattern: "帮我查...", "检查一下...", "看看..."
   - Frequency: 3+ occurrences indicates automation opportunity

2. **Manual Corrections**
   - User correcting agent's output repeatedly
   - Pattern: "不对...", "应该是...", "改成..."
   - Indicates agent behavior needs improvement

3. **Error Patterns**
   - Similar error messages appearing frequently
   - Pattern: "失败", "错误", "无法", "error", "failed"
   - Indicates systemic issues

4. **Improvement Opportunities**
   - Tasks that could be automated
   - Common workflows that could be streamlined
   - Missing features that users frequently request

### Step 3: Generate Report

Create a structured analysis report:

```markdown
## 📊 每日聊天回顾分析报告

**分析时间**: [Timestamp]
**分析范围**: 最近 7 天
**聊天数量**: [Number of chats analyzed]
**消息数量**: [Total messages analyzed]

---

### 🔴 重复问题 (需要关注)

#### 问题 1: [Issue Title]
- **出现次数**: X 次
- **涉及聊天**: [Chat IDs]
- **典型请求**:
  > [Example user request]

- **建议行动**:
  - [ ] 创建定时任务自动化
  - [ ] 创建 skill 简化操作
  - [ ] 创建 issue 记录需求

---

### 🟡 改进机会 (可选优化)

#### 机会 1: [Opportunity Title]
- **描述**: [Description]
- **潜在收益**: [Expected benefit]

---

### ✅ 运行良好

- [List of things working well]

---

### 📋 建议的下一步

1. **立即行动**: [High priority items]
2. **计划中**: [Medium priority items]
3. **观察**: [Low priority items]
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

## Pattern Detection Guidelines

### What to Look For

| Pattern Type | Indicators | Minimum Occurrences |
|--------------|------------|---------------------|
| Repetitive Request | Same/similar questions | 3+ |
| Manual Correction | User corrections | 2+ |
| Error Pattern | Error messages | 3+ |
| Feature Request | "希望能...", "如果有..." | 2+ |

### What to Ignore

- One-time issues
- Personal preferences
- Context-specific requests
- Test/debug messages

---

## Example Analysis

### Input (Chat History Excerpt):

```
## [2026-03-05T09:15:00Z] 📥 User
帮我看看今天有什么新的 GitHub issues

## [2026-03-05T09:20:00Z] 📤 Bot
正在检查 issues...

## [2026-03-06T09:10:00Z] 📥 User
查看今天的 GitHub issues

## [2026-03-07T09:30:00Z] 📥 User
今天有什么新 issues 吗
```

### Output (Report Section):

```markdown
#### 问题 1: GitHub Issues 每日检查
- **出现次数**: 3 次
- **涉及聊天**: oc_xxx
- **典型请求**:
  > 帮我看看今天有什么新的 GitHub issues

- **建议行动**:
  - [x] 创建定时任务自动化 (推荐: 每天 09:00)
  - [ ] 考虑创建 skill 简化操作
```

---

## Integration with Other Systems

### Phase 1: Report Only (Current)
- Analyze chat history
- Generate report
- Send via send_user_feedback

### Phase 2: Offline Discussion (Future)
- Use `leave_note` from offline-notes module
- Create discussion threads for important issues
- Track discussion outcomes

### Phase 3: Taste Integration (Issue #2335)
- **Manual Corrections** detected in Step 2 can be auto-saved as taste rules
- When a correction pattern occurs ≥2 times, suggest adding it as a taste rule
- Use `/taste add` command to save detected preferences
- Taste rules are auto-loaded into agent context to prevent future corrections

### Phase 4: Automated Actions (Future)
- Automatically create issues for detected problems
- Create skills for repetitive tasks
- Create schedules for automation opportunities

---

## Checklist

- [ ] Read all chat log files from workspace/logs/
- [ ] Analyzed patterns across all chats
- [ ] Identified at least 3 repetitive patterns (if any)
- [ ] Generated structured report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Create schedules without user confirmation
- Send reports to wrong chatId
- Include sensitive information in reports
- Make assumptions about user intent
- Skip the send_user_feedback step
