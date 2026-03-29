---
name: dogfood
description: Self-experience (dogfooding) specialist - simulates user activities to test disclaude features, discovers issues, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfood", "自测", "体验测试", "self-test", "自我检测".
allowed-tools: Read, Glob, Grep, Bash, WebSearch, send_user_feedback, Task
---

# Dogfood Skill — Self-Experience & Feedback

Simulate user activities to test disclaude's own capabilities, discover issues, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Triggering self-experience (dogfooding) sessions
- Testing disclaude features from a user's perspective
- Generating quality reports after version updates
- Discovering UX issues through anthropomorphic simulation

**Keywords that trigger this skill**: "自我体验", "dogfood", "自测", "体验测试", "self-test", "自我检测", "dogfooding"

## Core Principle

**Think and act like a real user, not a test script.**

The goal is NOT to run automated test cases, but to simulate genuine human interaction patterns — exploring features organically, asking ambiguous questions, combining features unexpectedly, and reacting like a real user would.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Dogfooding Process

### Step 1: Select Simulation Scenario

**Randomly select** from the following scenario categories. Use variety — don't pick the same category twice in a row.

| Category | Description | Example Activities |
|----------|-------------|-------------------|
| 🗣️ **Casual Chat** | Normal daily conversation | Greet, ask about weather, tell a joke, share a random thought |
| 🔧 **Feature Exploration** | Deliberately try features | Invoke skills, ask about capabilities, test slash commands |
| 🧪 **Edge Case Testing** | Push boundaries | Empty messages, very long input, mixed languages, special characters |
| 🎭 **Persona Play** | Adopt different user personas | Beginner user, power user, confused user, impatient user |
| 🔗 **Integration Testing** | Combine multiple features | Use skill A, then skill B, reference earlier results, chain operations |
| 📝 **Fuzzy Request** | Test understanding of vague requests | "帮我弄一下那个东西", "你能做到吗？", "我不太确定要什么" |
| 🔄 **Workflow Simulation** | Simulate real workflows | Create task → work on it → review → iterate → complete |
| 🚨 **Error Recovery** | Test how system handles mistakes | Provide wrong input, interrupt mid-task, ask to undo, change requirements |

**Selection method**: Use the current date/time to deterministically select a scenario category:
- `(day_of_month % number_of_categories)` gives the index

### Step 2: Simulate User Activity

For the selected scenario, act as a **real user** and interact with disclaude. Key guidelines:

**DO:**
- ✅ Use natural, conversational language
- ✅ React authentically (surprise, confusion, satisfaction, frustration)
- ✅ Ask follow-up questions based on responses
- ✅ Try unexpected combinations of features
- ✅ Notice and record anything that feels "off"
- ✅ Test at least 3 different interactions per session

**DON'T:**
- ❌ Use test-like language ("I will now test feature X")
- ❌ Skip recording observations
- ❌ Only test happy paths
- ❌ Ignore confusing or slow responses
- ❌ Test only one feature per session

### Step 3: Record Observations

During simulation, record observations in this structured format:

```
## Observation
- **Scenario**: [Which scenario category]
- **Activity**: [What you did]
- **Expected**: [What a user would expect]
- **Actual**: [What actually happened]
- **Severity**: 🟢 Good / 🟡 Minor / 🔴 Issue
- **Note**: [Any additional thoughts]
```

### Step 4: Analyze Codebase Health (Optional but Recommended)

After simulation, do a quick codebase health check:

1. **Check recent changes**:
   ```bash
   git log --oneline -20
   ```

2. **Run available tests**:
   ```bash
   npm test 2>&1 | tail -50
   ```

3. **Check for TODO/FIXME comments**:
   ```bash
   grep -r "TODO\|FIXME\|HACK\|XXX" --include="*.ts" -l | head -20
   ```

4. **Check dependency health**:
   ```bash
   npm outdated 2>&1 | head -20
   ```

### Step 5: Generate Structured Report

Create a comprehensive dogfooding report:

```markdown
## 🐕 Disclaude Dogfooding Report

**Date**: [ISO 8601 timestamp]
**Version**: [from package.json if available]
**Scenario Category**: [Selected category]
**Interactions Tested**: [Number]

---

### 📋 Summary

[2-3 sentence executive summary of findings]

---

### 🧪 Simulation Results

#### Interaction 1: [Activity Name]
- **Input**: [What was sent]
- **Response Quality**: ⭐⭐⭐⭐⭐ (1-5)
- **Response Time**: [Fast/Normal/Slow]
- **Observation**: [Detailed observation]
- **Severity**: 🟢/🟡/🔴

[... more interactions ...]

---

### 🔍 Codebase Health

| Check | Status | Details |
|-------|--------|---------|
| Tests | ✅/❌ | [X passing, Y failing] |
| Dependencies | ✅/⚠️/❌ | [Outdated count] |
| TODOs | [Count] | [Notable ones] |
| Recent Changes | [Count] | [Notable commits] |

---

### 🐛 Issues Found

#### Issue 1: [Title]
- **Severity**: 🔴 High / 🟡 Medium / 🟢 Low
- **Category**: Bug / UX / Performance / Feature Gap
- **Description**: [Detailed description]
- **Reproduction Steps**: [Step-by-step]
- **Expected Behavior**: [What should happen]
- **Actual Behavior**: [What actually happens]

[... more issues ...]

---

### ✨ Highlights

[Things that worked particularly well — positive feedback is important too!]

---

### 💡 Suggestions

[Improvement ideas based on the session]

---

### 📊 Overall Score

| Dimension | Score (1-10) | Notes |
|-----------|-------------|-------|
| Response Quality | [N] | [Notes] |
| Response Speed | [N] | [Notes] |
| Feature Completeness | [N] | [Notes] |
| Error Handling | [N] | [Notes] |
| UX / Conversation Flow | [N] | [Notes] |
| **Overall** | **[N]** | [Notes] |

*Report generated by /dogfood skill*
```

### Step 6: Submit Report

**Option A: Send to current chat** (default)
```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

**Option B: Create GitHub Issue** (if critical issues found)
```bash
gh issue create --repo hs3180/disclaude \
  --title "🐕 Dogfooding Report: [date] - [summary]" \
  --body "[Full report]" \
  --label "feedback"
```

**Decision logic**:
- If 🔴 issues found → Create GitHub Issue + Send to chat
- If only 🟡 issues → Send to chat only
- If all 🟢 → Send brief positive report to chat

---

## Schedule Configuration

To enable automatic dogfooding sessions, create a schedule file:

```markdown
---
name: "Dogfood Self-Experience"
cron: "0 14 * * 1,3,5"  # Mon/Wed/Fri at 2:00 PM
enabled: true
blocking: true
chatId: "{target_chat_id}"
---

Please execute the dogfood skill for a self-experience session.

Requirements:
1. Randomly select a simulation scenario category
2. Simulate at least 3 user interactions
3. Record all observations
4. Generate a structured report
5. Send the report using send_user_feedback to chatId: {chatId}

Note:
- Vary the scenario each time (use day_of_month % 8 as category index)
- Focus on discovering real issues, not just confirming things work
- Be honest about problems found
```

---

## Quality Guidelines

### Good Dogfooding Sessions:
- ✅ Simulate genuine user behavior
- ✅ Test both happy paths and edge cases
- ✅ Record specific, actionable observations
- ✅ Include both positive and negative findings
- ✅ Provide concrete reproduction steps for issues
- ✅ Rate severity honestly

### Bad Dogfooding Sessions:
- ❌ Only test obvious functionality
- ❌ Skip recording observations
- ❌ Only report positive findings
- ❌ Use test-script-like language
- ❌ Report vague issues without details

---

## Checklist

- [ ] Selected a scenario category (varied from previous sessions)
- [ ] Simulated at least 3 user interactions
- [ ] Recorded observations with severity ratings
- [ ] Performed codebase health check
- [ ] Generated structured report with scores
- [ ] Submitted report via send_user_feedback (and GitHub Issue if critical)

---

## DO NOT

- Create GitHub Issues for minor/positive findings
- Use the same scenario category every time
- Skip the codebase health check
- Test only one interaction per session
- Report issues without reproduction steps
- Submit reports without severity ratings
- Ignore positive findings (they help maintain morale)
