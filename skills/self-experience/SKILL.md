---
name: self-experience
description: Self-experience (dogfooding) specialist - simulates user interactions to explore features, discover issues, and generate structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "自动体验", "功能探索", "self-experience", "feature exploration". Triggered by scheduler for automated version validation.
allowed-tools: Read, Glob, Grep, Bash, WebSearch, send_user_feedback
---

# Self-Experience (Dogfooding) Specialist

Simulate user interactions to explore disclaude's features, discover issues, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Automated post-release feature validation
- Simulating user interactions to discover bugs and UX issues
- Generating structured feedback reports after version updates
- Proactive exploration of feature combinations and edge cases

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自动体验", "功能探索", "self-experience", "feature exploration", "版本验证"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based creative simulation, NOT predefined test scripts.**

The LLM should:
1. Understand the current version and available features
2. Creatively design exploration scenarios based on the codebase
3. Simulate realistic user behavior and expectations
4. Evaluate responses critically from a user's perspective
5. Generate actionable feedback

---

## Self-Experience Process

### Step 1: Environment Analysis

**1.1 Read Current Version**
```bash
cat package.json | grep '"version"'
```

**1.2 Load Experience History**
```bash
cat workspace/data/self-experience-history.md 2>/dev/null || echo "No history found"
```

**1.3 Discover Available Features**
Read key files to understand what features exist:
- `CLAUDE.md` - Architecture overview
- `skills/` directory - Available skills
- `src/` directory - Core functionality
- `packages/mcp-server/src/tools/` - Available MCP tools
- Recent git log for changes since last experience:
```bash
git log --oneline -20
```

**1.4 Check Previous Experience**
If history file exists, verify:
- Last experienced version
- Previously discovered issues (to check if resolved)
- Features not yet explored

### Step 2: Activity Planning

Based on the environment analysis, **creatively design** 3-5 exploration activities. Each activity should simulate a different user persona and scenario.

#### Activity Categories

| Category | Description | Example Scenarios |
|----------|-------------|-------------------|
| 🎭 **Conversation Quality** | Test multi-turn dialogue, context retention, response quality | Ask follow-up questions, change topics mid-conversation, ask for clarifications |
| 🔧 **Skill Testing** | Explore available skills and their responses | Trigger each skill with realistic inputs, test edge cases |
| 🌐 **MCP Tool Validation** | Test available MCP tools | Send messages, create cards, manage schedules |
| 🧪 **Edge Case Simulation** | Push boundaries with unusual inputs | Empty messages, very long inputs, special characters, ambiguous requests |
| 🔗 **Feature Combination** | Test interactions between features | Use multiple skills in sequence, combine tools |
| 📊 **Documentation & Guidance** | Verify help text, error messages, guidance quality | Ask for help, trigger errors, request explanations |

#### Activity Design Guidelines

For each activity, define:
1. **Persona**: Who is simulating this? (new user, power user, confused user, etc.)
2. **Scenario**: What are they trying to do?
3. **Expected Behavior**: What should a good response look like?
4. **Evaluation Criteria**: How to judge success/failure?

**IMPORTANT**: Activities should be **different each run**. Use the version number, date, and random selection to ensure variety. Never repeat the exact same activities.

### Step 3: Execute Exploration

For each planned activity:

**3.1 Simulate the Interaction**
- Analyze the relevant source code to predict behavior
- Read recent chat logs from `workspace/logs/` to see real user interactions (if available)
- If MCP tools are available, consider actually invoking them
- Use `WebSearch` to verify if documentation matches reality

**3.2 Evaluate the Experience**
Score each activity on these dimensions:

| Dimension | Score (1-5) | Criteria |
|-----------|-------------|----------|
| **Functionality** | Does it work as expected? | 5=Perfect, 1=Broken |
| **Clarity** | Is the response clear and understandable? | 5=Crystal clear, 1=Confusing |
| **Helpfulness** | Does it solve the user's problem? | 5=Exceeds expectations, 1=Unhelpful |
| **Robustness** | How does it handle edge cases? | 5=Graceful, 1=Crashes |
| **UX Quality** | Is the experience pleasant? | 5=Delightful, 1=Frustrating |

**3.3 Record Findings**
For each activity, note:
- What worked well ✅
- What could be improved ⚠️
- What was broken or problematic ❌
- Suggestions for improvement 💡

### Step 4: Generate Report

Create a comprehensive structured report:

```markdown
## 🐕 Self-Experience Report (Dogfooding)

**Version**: [current version]
**Date**: [ISO date]
**Activities Completed**: [count]
**Overall Score**: [average score]/5.0 ⭐

---

### 📋 Activities Summary

#### Activity 1: [Activity Name]
- **Category**: [Conversation/Skill/Tool/Edge Case/Combination/Docs]
- **Persona**: [New user/Power user/Confused user/etc.]
- **Scenario**: [Brief description]
- **Scores**:
  - Functionality: [X]/5
  - Clarity: [X]/5
  - Helpfulness: [X]/5
  - Robustness: [X]/5
  - UX Quality: [X]/5
- **Findings**:
  - ✅ [What worked]
  - ⚠️ [What needs improvement]
  - ❌ [What was broken]
- **Suggestions**: [Improvement ideas]

---

### 🔴 Issues Discovered

#### Issue 1: [Title]
- **Severity**: [Critical/Major/Minor/Suggestion]
- **Category**: [Bug/UX/Feature/Documentation]
- **Description**: [Detailed description]
- **Reproduction Steps**: [Steps to reproduce]
- **Expected vs Actual**: [What should happen vs what happens]
- **Suggested Fix**: [How to fix it]

---

### 🟢 Highlights

- [List of things that worked exceptionally well]

---

### 📊 Score Summary

| Activity | Functionality | Clarity | Helpfulness | Robustness | UX |
|----------|:---:|:---:|:---:|:---:|:---:|
| [Activity 1] | [X] | [X] | [X] | [X] | [X] |
| [Activity 2] | [X] | [X] | [X] | [X] | [X] |
| **Average** | **[X]** | **[X]** | **[X]** | **[X]** | **[X]** |

---

### 🔄 Comparison with Last Experience

| Metric | Last Run | This Run | Trend |
|--------|----------|----------|-------|
| Version | [version] | [version] | - |
| Overall Score | [X]/5 | [X]/5 | [↑/↓/→] |
| Issues Found | [N] | [N] | [↑/↓/→] |
| Issues Resolved | - | [N] | - |

---

### 📋 Recommended Actions

1. **Immediate** (Critical issues):
   - [ ] [Action item]

2. **Short-term** (Next release):
   - [ ] [Action item]

3. **Long-term** (Future improvements):
   - [ ] [Action item]
```

### Step 5: Save History and Send Report

**5.1 Save Experience History**
Update `workspace/data/self-experience-history.md`:

```markdown
## Self-Experience History

### [Date] - v[version]
- Activities: [count]
- Overall Score: [X]/5
- Issues Found: [N]
- Key Findings: [Brief summary]
```

**5.2 Send Report**
**CRITICAL**: Always send the report to the user using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Schedule Configuration

To enable automated self-experience, create a schedule file:

```markdown
---
name: "Self-Experience (Dogfooding)"
cron: "0 10 * * 1"  # Every Monday at 10am
enabled: true
blocking: true
chatId: "{target_chat_id}"
---

请使用 self-experience skill 执行一次自我体验。

要求：
1. 读取 package.json 获取当前版本
2. 检查 workspace/data/self-experience-history.md 获取历史记录
3. 分析 skills/ 和 src/ 了解可用功能
4. 设计 3-5 个不同的探索活动（确保与上次不同）
5. 执行探索并评估体验质量
6. 生成结构化报告
7. 保存历史记录到 workspace/data/self-experience-history.md
8. 使用 send_user_feedback 发送报告
```

---

## Activity Inspiration Pool

When designing activities, draw inspiration from these areas (pick creatively, don't use all):

### Conversation Scenarios
- "I'm a new user, help me understand what you can do"
- "Can you explain [complex feature] in simple terms?"
- "I made a mistake, can you help me fix it?"
- "What's the difference between [feature A] and [feature B]?"
- "Can you help me with [ambiguous request]?"

### Skill Exploration
- Trigger each available skill with a realistic input
- Test skill with minimal input (just the trigger keyword)
- Test skill with overly detailed input
- Test skill with contradictory input

### MCP Tool Testing
- Send a message to a chat
- Create an interactive card
- Read recent chat history
- Check schedule status

### Edge Cases
- Very long message (> 2000 chars)
- Empty or whitespace-only input
- Mixed language input (Chinese + English + emoji)
- Special characters and formatting
- Rapid sequential requests

### Feature Combinations
- Use feedback skill after discovering an issue
- Create a schedule from a self-experience finding
- Combine multiple tools in a single workflow

---

## Anti-Recursion Rules

**IMPORTANT**: When running as a scheduled task:
- Do NOT create new scheduled tasks
- Do NOT modify existing scheduled tasks
- Do NOT submit GitHub issues automatically (only report findings)
- Focus on analysis and reporting, not automated actions

---

## Checklist

- [ ] Read current version from package.json
- [ ] Loaded and reviewed experience history
- [ ] Discovered available features (skills, tools, recent changes)
- [ ] Designed 3-5 creative exploration activities
- [ ] Executed each activity and evaluated results
- [ ] Generated comprehensive structured report
- [ ] Saved experience history to workspace/data/self-experience-history.md
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Create schedules during execution (anti-recursion)
- Submit GitHub issues automatically (only report findings)
- Repeat the exact same activities as previous runs
- Use predefined test scripts instead of creative simulation
- Skip the send_user_feedback step
- Report issues without checking if they were already known
- Include sensitive information (API keys, user IDs, etc.) in reports
