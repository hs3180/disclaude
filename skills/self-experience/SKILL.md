---
name: self-experience
description: Self-experience (dogfooding) module - automatically explores own features from a new-user perspective, simulates diverse interactions, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验".
allowed-tools: Read, Glob, Grep, Bash, WebSearch, send_user_feedback
---

# Self-Experience (Dogfooding)

Automatically explore own features from a new-user perspective, simulate diverse interactions, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Automated self-testing of all available features
- Exploring the system as a first-time user
- Generating structured quality feedback
- Discovering usability issues and edge cases
- Validating recent changes or new features

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验", "dog food", "体验测试"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Explore freely as a new user, not as a developer.**

The goal is to discover what a real user would experience — confusing prompts, missing error messages, unintuitive workflows, or broken features. Do NOT read source code for answers; interact with features as a user would.

---

## Exploration Process

### Step 1: Discover Available Features

Scan the `skills/` directory to enumerate all available skills:

```bash
ls skills/
```

For each skill, read its SKILL.md to understand what it does and how users invoke it:

```
Read skills/{skill-name}/SKILL.md
```

Build a feature catalog:

| Skill | Trigger Keywords | Core Function | User-Facing Description |
|-------|-----------------|---------------|------------------------|
| ... | ... | ... | ... |

### Step 2: Select Exploration Targets

Choose **3-5 features** to explore based on:

| Priority | Selection Criteria |
|----------|--------------------|
| 🔴 High | Recently added or modified skills (check git log) |
| 🟡 Medium | Core features used daily |
| 🟢 Low | Less common features or edge-case scenarios |

**Variety rule**: Select at least one from each category:
- **Interactive skill** (requires user input, e.g., feedback, survey)
- **Automated skill** (scheduler-driven, e.g., pr-scanner, daily-chat-review)
- **Informational skill** (e.g., schedule-recommend, next-step)

### Step 3: Simulate User Interactions

For each selected feature, simulate **2-3 distinct user personas** interacting with it:

#### Persona Types

| Persona | Behavior | Example |
|---------|----------|---------|
| **Newbie** | Uses natural language, vague requests | "帮我看看有什么功能" |
| **Power User** | Uses exact commands, tests edge cases | "/feedback --verbose" |
| **Confused User** | Asks ambiguous questions, makes typos | "怎么用这个？？" |
| **Non-technical** | Avoids jargon, asks "why" not "how" | "能简单说一下吗" |

#### Interaction Scenarios

For each persona, test:

1. **Happy path**: Normal usage → Does it work as described?
2. **Error path**: Invalid input → Are errors clear and helpful?
3. **Edge case**: Unusual input → Does it crash or handle gracefully?
4. **Multi-step**: Chained operations → Does state persist correctly?

### Step 4: Evaluate UX Quality

Rate each feature across these dimensions:

| Dimension | Rating Criteria |
|-----------|----------------|
| **Discoverability** | Can a new user find and understand this feature? |
| **Clarity** | Are prompts, errors, and outputs easy to understand? |
| **Error Handling** | Are error messages helpful? Does it recover gracefully? |
| **Completeness** | Does the feature do what it promises? |
| **Consistency** | Does it behave like other features in the system? |
| **Performance** | Is response time acceptable? |

Rating scale: ⭐⭐⭐⭐⭐ (Excellent) to ⭐ (Broken)

### Step 5: Generate Feedback Report

Create a structured report following the template below.

---

## Report Template

```markdown
# 🐶 Self-Experience Report

**Date**: [Date]
**Version**: [from package.json or git describe]
**Duration**: [How long the exploration took]
**Features Tested**: [Number] / [Total available]

---

## Executive Summary

[2-3 sentences: Overall impression, most critical finding, top recommendation]

---

## Feature Evaluations

### 1. [Feature Name] — ⭐⭐⭐⭐ (4/5)

**Persona Tested**: [Newbie / Power User / Confused User]
**Scenario**: [What was tested]

| Dimension | Rating | Notes |
|-----------|--------|-------|
| Discoverability | ⭐⭐⭐⭐ | Easy to find via keyword trigger |
| Clarity | ⭐⭐⭐ | Output format could be clearer |
| Error Handling | ⭐⭐⭐⭐ | Good error messages |
| Completeness | ⭐⭐⭐⭐⭐ | Does everything promised |
| Consistency | ⭐⭐⭐⭐ | Matches system patterns |
| Performance | ⭐⭐⭐⭐⭐ | Fast response |

**What worked well**:
- [Specific positive finding]

**What could be improved**:
- [Specific improvement with suggestion]

**Surprising finding**:
- [Something unexpected, good or bad]

---

### 2. [Feature Name] ...

[Repeat for each tested feature]

---

## Cross-Cutting Issues

### Issues Affecting Multiple Features

| Issue | Affected Features | Severity | Suggestion |
|-------|-------------------|----------|------------|
| [Issue description] | [List] | 🔴/🟡/🟢 | [Fix suggestion] |

---

## Top Recommendations

### 🔴 Critical (Fix Soon)
1. [Most important finding]
2. [Second most important]

### 🟡 Improvement (Plan for Next Sprint)
1. [Improvement suggestion]
2. [Another improvement]

### 🟢 Nice to Have (Backlog)
1. [Low priority suggestion]

---

## Meta Feedback

**Self-experience process itself**:
- Was this exploration thorough? [Yes/Partially/No]
- What was missed? [List gaps]
- Recommended frequency: [Weekly/Biweekly/Monthly]
```

### Step 6: Submit Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

If the report contains **actionable bug findings**, also create GitHub issues:

```bash
gh issue create --repo hs3180/disclaude \
  --title "[Brief description of the bug/issue]" \
  --body "[Detailed description from the report]" \
  --label "bug" \
  --label "feedback"
```

**Issue creation rules**:
- Only create issues for 🔴 Critical findings
- Use `bug` label for broken features
- Use `enhancement` label for UX improvements
- Reference this report in the issue body: "Discovered via self-experience (#1560)"

---

## Exploration Guidelines

### What Makes Good Dogfooding

- ✅ **Be a user, not a developer**: Don't read source code for answers
- ✅ **Test the documentation**: Can you understand features from SKILL.md alone?
- ✅ **Try unexpected inputs**: What happens with empty strings? Very long text? Mixed languages?
- ✅ **Test real workflows**: Chain multiple features together
- ✅ **Note feelings**: Was anything frustrating? Confusing? Delightful?

### What to Avoid

- ❌ Don't just read code and report code smells
- ❌ Don't test features you already know work perfectly
- ❌ Don't skip error cases — they're the most valuable findings
- ❌ Don't make assumptions about what users want — simulate real usage
- ❌ Don't create more than 3 GitHub issues per session

---

## Integration with Other Systems

### Schedule Integration

To run self-experience periodically, create a schedule:

```markdown
---
name: "Self-Experience"
cron: "0 10 * * 1"  # Every Monday 10am
enabled: true
blocking: true
chatId: "{chatId}"
---

# Weekly Self-Experience

使用 self-experience skill 进行每周自我体验。

要求：
1. 选择 3-5 个功能进行体验
2. 以新用户视角模拟交互
3. 生成结构化反馈报告
4. 使用 send_user_feedback 发送报告
5. 对严重问题创建 GitHub issue
```

### Related Skills

- **daily-chat-review**: Use chat history patterns to identify features that need testing
- **feedback**: Use to submit discovered issues
- **schedule-recommend**: May recommend scheduling this skill periodically

---

## Checklist

- [ ] Enumerated all available skills from `skills/`
- [ ] Selected 3-5 features with variety
- [ ] Simulated at least 2 different user personas
- [ ] Tested happy path AND error paths
- [ ] Rated each feature across 6 dimensions
- [ ] Generated structured report
- [ ] **Sent report via send_user_feedback** (CRITICAL)
- [ ] Created GitHub issues for critical findings (if any)

---

## DO NOT

- Create more than 3 GitHub issues per self-experience session
- Send reports to wrong chatId
- Include internal implementation details in the report (user perspective only)
- Skip the send_user_feedback step
- Report issues without concrete reproduction steps
- Test features that require unavailable external tools (mark as "untestable" instead)
