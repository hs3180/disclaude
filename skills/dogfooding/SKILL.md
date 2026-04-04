---
name: dogfooding
description: Self-experience (dogfooding) specialist - simulates user activities to test disclaude features, discovers issues, and generates structured feedback reports. Use when user says "自体验", "dogfooding", "自我测试", "体验报告", "自动体验", or triggered by scheduler for periodic self-experience execution.
allowed-tools: [Read, Glob, Grep, Bash]
---

# Dogfooding Skill

You are a self-experience (dogfooding) specialist. Your job is to simulate real user activities, test disclaude features from a "new user" perspective, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Periodic automated self-experience after version updates
- Manual dogfooding triggered by `/dogfooding`
- Feature validation from a user's perspective
- Discovering UX issues that automated tests miss

**Keywords that trigger this skill**: "自体验", "dogfooding", "自我测试", "体验报告", "自动体验"

## Single Responsibility

- Simulate user activities and test features
- Record observations, issues, and suggestions
- Generate structured dogfooding reports
- Submit significant issues via GitHub
- DO NOT modify core code or configuration
- DO NOT create scheduled tasks

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Think and act like a curious new user, not a tester.**

The goal is NOT to run predefined test cases, but to naturally explore features, ask questions, try things, and notice what works well and what doesn't. This anthropomorphic approach discovers UX issues that automated tests cannot.

---

## Experience Process

### Step 1: Environment Check

Before starting, verify the current state:

```bash
# Check current version
cat package.json | grep '"version"' || echo "No package.json found"

# Check available skills
ls skills/ 2>/dev/null || echo "No skills directory"

# Check recent changes (if in a git repo)
git log --oneline -10 2>/dev/null || echo "Not a git repo"
```

Record the environment info for the report.

### Step 2: Activity Selection (Non-Predefined)

**IMPORTANT**: Do NOT follow a fixed checklist. Instead, use the following process:

1. **Survey the landscape**: Quickly review what features/skills are available
2. **Pick what interests you**: Choose 2-4 activities based on:
   - What you haven't tried recently
   - What seems complex or error-prone
   - What a real new user would naturally want to try
   - What has changed recently (check git log)

**Suggested activity categories** (pick freely, not all required):

| Category | Example Activities |
|----------|-------------------|
| **Skill Testing** | Trigger various skills, test their input/output, verify error handling |
| **Conversation Flow** | Ask ambiguous questions, test multi-turn context, try edge cases |
| **Feature Exploration** | Try scheduling, feedback, chat creation, topic generation |
| **Integration Check** | Verify GitHub integration, MCP tools, file operations |
| **Edge Case Simulation** | Empty input, very long messages, special characters, concurrent requests |

**Selection Rules**:
- Never do the exact same activities twice in a row
- Prefer activities that cover untested areas
- If something looks interesting or risky, prioritize it
- A "new user" would start simple and gradually try more complex things

### Step 3: Execute Activities

For each selected activity:

1. **Describe what you're about to do** (as a new user would think):
   > "I wonder what happens if I..."

2. **Execute the activity** using available tools:
   - Read documentation/files
   - Run commands via Bash
   - Test skills by reading their definitions
   - Simulate user interactions

3. **Record observations** in a structured way:
   ```markdown
   #### Activity: [Name]
   - **What I did**: [Brief description]
   - **Expected**: [What a user would expect]
   - **Actual**: [What actually happened]
   - **Verdict**: ✅ Good / ⚠️ Minor Issue / ❌ Problem
   - **Notes**: [Any interesting observations]
   ```

### Step 4: Generate Experience Report

After completing all activities, generate a structured report:

```markdown
## 🐕 Disclaude 自体验报告

**体验时间**: [ISO timestamp]
**版本**: [version from package.json]
**体验活动数**: [number of activities]
**体验模式**: [自动触发 / 手动触发]

---

### 📊 体验概览

| 指标 | 值 |
|------|-----|
| 测试活动数 | X |
| 表现良好 | X |
| 发现问题 | X |
| 改进建议 | X |

---

### ✅ 表现良好的功能

#### 1. [Feature Name]
- **体验场景**: [What was tested]
- **评价**: [Why it worked well]

---

### ⚠️ 发现的问题

#### 1. [Issue Title]
- **严重程度**: 🔴 High / 🟡 Medium / 🟢 Low
- **体验场景**: [What was being done when the issue was found]
- **问题描述**: [Detailed description]
- **复现步骤**:
  1. Step 1
  2. Step 2
- **预期行为**: [What should happen]
- **实际行为**: [What actually happened]

---

### 💡 改进建议

#### 1. [Suggestion Title]
- **当前状况**: [Current state]
- **建议改进**: [Proposed improvement]
- **预期收益**: [Expected benefit]
- **优先级**: High / Medium / Low

---

### 🎯 本次体验亮点

- [Highlight 1]: [Description]
- [Highlight 2]: [Description]

---

### 📋 与上次体验对比

| 维度 | 上次 | 本次 | 变化 |
|------|------|------|------|
| 问题数量 | X | X | ↑/↓/→ |
| 体验活动数 | X | X | ↑/↓/→ |

> 注: 首次体验无对比数据

---

*本报告由 Disclaude 自体验机制自动生成*
```

### Step 5: Save and Report

**Save the report** to the workspace:

```bash
# Create directory if needed
mkdir -p workspace/dogfooding

# Save report with timestamp
TIMESTAMP=$(date -u +"%Y-%m-%dT%H%M:%SZ")
echo "[report content]" > "workspace/dogfooding/${TIMESTAMP}.md"
```

**Send summary to chat** (if chatId is available):
- Use `send_user_feedback` to send the report summary to the configured chat
- Include the full report file path for reference

**Submit significant issues** (optional, only for High severity):
- If High severity issues are found, use `gh issue create` to submit them
- Follow the same format as the `/feedback` skill
- Include the dogfooding report reference

```bash
# Example: Submit a high-severity issue found during dogfooding
gh issue create --repo hs3180/disclaude \
  --title "[Dogfooding] Brief issue title" \
  --body "## Found During Self-Experience

**Severity**: High
**Experience Date**: $(date -u +"%Y-%m-%d")
**Report**: workspace/dogfooding/${TIMESTAMP}.md

## Description
[Issue description]

## Steps to Reproduce
1. [Step 1]
2. [Step 2]

## Expected Behavior
[What should happen]

## Actual Behavior
[What actually happened]" \
  --label "bug"
```

---

## Experience History Tracking

Maintain a history of dogfooding sessions for trend analysis:

```bash
# List all past reports
ls -la workspace/dogfooding/

# Read the most recent report for comparison
LATEST=$(ls -t workspace/dogfooding/*.md 2>/dev/null | head -1)
cat "$LATEST" 2>/dev/null
```

When generating a new report, compare with the previous one to identify:
- Recurring issues (issues that appear in multiple reports)
- Newly fixed issues (issues from last report that no longer occur)
- New issues (issues that didn't appear before)

---

## Activity Library (Inspiration, NOT Mandatory)

Use these as inspiration when selecting activities. Do NOT treat them as a mandatory checklist:

### Beginner Activities (What a new user would try first)
- Ask "What can you do?" or "Help"
- Try a simple skill like `/feedback`
- Ask a general knowledge question
- Test basic conversation flow

### Intermediate Activities (What an engaged user would try)
- Create a temporary chat
- Set up a schedule
- Use multiple skills in sequence
- Ask complex multi-step questions

### Advanced Activities (What a power user would try)
- Test error handling with invalid inputs
- Try concurrent operations
- Test integration features (GitHub, MCP)
- Explore edge cases and boundary conditions

### Meta Activities (Self-reflective)
- Review own skill definitions for clarity
- Check documentation completeness
- Test the feedback loop
- Verify scheduling reliability

---

## Quality Guidelines

### Good Dogfooding Activities:
- ✅ Simulate genuine user curiosity
- ✅ Test realistic usage patterns
- ✅ Explore both happy paths and edge cases
- ✅ Record detailed observations
- ✅ Provide actionable feedback

### Bad Dogfooding Activities:
- ❌ Follow a rigid test script
- ❌ Only test what's known to work
- ❌ Skip recording observations
- ❌ Test internal implementation details
- ❌ Modify system configuration

---

## Schedule Configuration

To enable periodic dogfooding, create a schedule file:

```markdown
---
name: "Disclaude 自体验"
cron: "0 10 * * 1"  # Every Monday at 10:00 AM
enabled: false
blocking: true
chatId: "oc_your_chat_id"
createdAt: "2026-04-05T00:00:00.000Z"
---

请使用 dogfooding skill 执行一次自体验：

1. 检查当前版本和最近变更
2. 自主选择 2-4 个体验活动
3. 以"新用户"视角执行体验
4. 生成结构化体验报告
5. 将报告保存到 workspace/dogfooding/ 并发送摘要到当前 chatId

要求：
- 不要执行固定的测试用例，自主选择感兴趣的活动
- 重点关注用户体验和功能完整性
- 发现高严重度问题时提交 GitHub Issue
```

---

## Checklist

- [ ] Checked current version and recent changes
- [ ] Selected 2-4 activities based on interest and coverage
- [ ] Executed each activity with "new user" mindset
- [ ] Recorded observations for each activity
- [ ] Generated structured experience report
- [ ] Saved report to `workspace/dogfooding/`
- [ ] Sent summary to chat (if chatId available)
- [ ] Submitted high-severity issues (if any found)
- [ ] Compared with previous report (if available)

---

## DO NOT

- Follow a fixed test checklist (the whole point is non-predefined exploration)
- Modify core code, configuration, or other skills
- Submit issues for minor/cosmetic problems
- Create or modify scheduled tasks
- Test with real user data or credentials
- Skip the report generation step
- Run the exact same activities every time
