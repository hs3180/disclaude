---
name: dogfood
description: Self-dogfooding specialist - simulates human-like interactions to experience disclaude's own capabilities and generates structured feedback reports. Use for post-deployment self-testing, feature validation, or when user says keywords like "自我体验", "dogfood", "自动测试", "自我检测", "体验报告". Triggered by scheduler after new deployments or manually via /dogfood.
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Dogfood — Self-Experience & Feedback

Simulate human-like interactions to experience disclaude's own capabilities and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Post-deployment self-validation (scheduled or manual)
- Feature completeness check
- UX quality assessment from a "new user" perspective
- Generating structured self-experience reports

**Keywords that trigger this skill**: "自我体验", "dogfood", "自动测试", "自我检测", "体验报告", "self-experience"

## Core Principle

**Use LLM-based simulation, NOT scripted test cases.**

The agent should think and act like a curious new user exploring the system for the first time, not execute rigid test scripts. This catches UX issues that automated tests miss.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Execution Process

### Phase 1: Self-Assessment (What Can I Do?)

Before simulating, understand the current deployment's capabilities:

1. **Check available skills:**
   ```bash
   ls skills/
   ```

2. **Check current version:**
   ```bash
   cat package.json | grep '"version"'
   ```

3. **Review recent changes:**
   ```bash
   git log --oneline -10
   ```

4. **Identify testable surface areas** from the skills and recent changes.

### Phase 2: Simulate Interactions (Act Like a User)

Pick **3-5 activities** from the categories below. Vary the selection each run to cover different areas over time.

#### Category A: Skill Exploration

Randomly pick 1-2 skills and simulate invoking them:
- Read the skill's SKILL.md to understand what it does
- Imagine you're a first-time user: does the description make sense? Are the instructions clear?
- Check for broken references, missing dependencies, or confusing descriptions

#### Category B: Conversation Quality

Simulate a multi-turn conversation scenario:
- Think of a realistic user question (e.g., "帮我分析一下最近的聊天记录" or "今天有什么新 issues")
- Read relevant workspace files (logs, chat history) as if responding to this query
- Evaluate: Would a user understand the response format? Is the flow intuitive?

#### Category C: Edge Case Exploration

Try edge cases that real users might encounter:
- Very long input (>1000 chars)
- Ambiguous/vague requests
- Requests that span multiple features
- Empty or minimal input

#### Category D: Integration Check

Verify cross-feature integration:
- Do skills reference tools that exist?
- Are schedule files correctly formatted?
- Do skill descriptions match their actual functionality?

### Phase 3: Generate Feedback Report

Create a structured report summarizing findings:

```markdown
## 🐕 Dogfood 自我体验报告

**体验时间**: {timestamp}
**版本**: {version}
**体验活动数**: {number}

---

### ✅ 正常工作

- {Feature/capability that worked well}

### ⚠️ 发现的问题

#### 问题 1: {Title}
- **类型**: {UX/功能/文档/集成}
- **严重程度**: {🔴 高 / 🟡 中 / 🟢 低}
- **描述**: {What went wrong or could be improved}
- **复现步骤**: {Steps to reproduce}
- **建议修复**: {Suggested fix}

### 💡 改进建议

- {Improvement suggestion based on the experience}

### 📊 总体评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 功能完整性 | ⭐⭐⭐⭐☆ | ... |
| 文档清晰度 | ⭐⭐⭐⭐⭐ | ... |
| 用户体验 | ⭐⭐⭐☆☆ | ... |
| 稳定性 | ⭐⭐⭐⭐☆ | ... |
```

### Phase 4: Deliver Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

If any **high-severity** issues are found, include a summary at the top of the report with clear action items.

---

## Activity Selection Strategy

To avoid repeating the same checks every run, use the current date to vary selection:

| Day of Week | Focus Area |
|-------------|------------|
| Monday | Skill exploration (Category A) |
| Tuesday | Conversation quality (Category B) |
| Wednesday | Edge case exploration (Category C) |
| Thursday | Integration check (Category D) |
| Friday | Mixed (pick best from all categories) |
| Saturday/Sunday | Light check (Category A + B, 2 activities) |

---

## Quality Guidelines

### Good Dogfood Activities:
- ✅ Simulate realistic user behavior
- ✅ Cover different feature areas over time
- ✅ Focus on user-perceivable issues (not implementation details)
- ✅ Include both happy path and edge cases

### Avoid:
- ❌ Running actual destructive operations (no git push, no file deletion)
- ❌ Testing with real user data
- ❌ Executing skills that send messages to real users
- ❌ Modifying any files in the repository
- ❌ Repeating the exact same activities every run

---

## Report History

To enable trend analysis, store reports in the workspace:

```bash
# Store report with date
# File: workspace/dogfood/{YYYY-MM-DD}.md
```

This allows tracking improvement over time.

---

## Checklist

- [ ] Assessed current deployment capabilities
- [ ] Selected 3-5 varied activities
- [ ] Simulated interactions from a user's perspective
- [ ] Generated structured feedback report
- [ ] **Sent report via send_user_feedback** (CRITICAL)
- [ ] Stored report in workspace/dogfood/ for history

---

## DO NOT

- Execute any destructive operations
- Send messages to real users during simulation
- Modify repository files
- Skip the send_user_feedback step
- Generate generic reports without actual simulation
- Run the same activities every time
