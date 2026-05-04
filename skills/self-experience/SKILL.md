---
name: self-experience
description: Self-experience (dogfooding) module - automatically explores own features from a new-user perspective, simulates diverse interactions, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验".
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Self-Experience (Dogfooding)

Automatically experience disclaude's own features from a new-user perspective, simulate diverse interactions, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Periodic self-testing of disclaude features
- Simulating diverse user interactions to discover issues
- Generating structured feedback for developers
- Dogfooding new features after deployment

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Act as a curious new user**, freely exploring features without predetermined test cases. The LLM should autonomously decide what to try based on current capabilities, simulating organic user behavior.

---

## Experience Process

### Phase 1: Capability Discovery

Discover what features and skills are currently available:

1. **List available skills**:
   ```bash
   ls skills/
   ```

2. **Read key configuration**:
   ```bash
   head -50 CLAUDE.md
   ```

3. **Check recent changes**:
   ```bash
   git log --oneline -20
   ```

4. **Identify new or recently updated features**:
   ```bash
   git log --since="7 days ago" --oneline --name-only | head -40
   ```

5. **Check recent chat logs for common user requests**:
   ```bash
   ls workspace/logs/ 2>/dev/null
   ```

Based on discovery, select 3-5 features to experience. Prioritize:
- Recently added or updated features
- Core capabilities that users interact with most
- Features that haven't been tested recently

### Phase 2: Simulated Experience

For each selected feature, simulate a new-user interaction:

**Simulation Guidelines**:
- Use natural, informal language (as a real user would)
- Try edge cases: very long input, empty messages, mixed languages
- Test error handling: invalid inputs, missing parameters
- Combine features: use multiple skills in sequence
- Express confusion or ask clarifying questions

**Simulation Categories**:

| Category | What to Try | Example |
|----------|-------------|---------|
| **Basic Chat** | Normal conversation, questions, requests | "帮我总结一下这个项目" |
| **Skill Invocation** | Trigger various skills | Try different skills and observe behavior |
| **Edge Cases** | Unusual inputs | Super long text, empty message, emoji-only |
| **Multi-turn** | Follow-up questions, corrections | "不对，我想要的是..." |
| **Error Recovery** | Invalid operations | Non-existent files, wrong parameters |
| **Feature Combination** | Use multiple features together | Search + summarize + generate |

**For each simulation**:
1. Record what you tried
2. Note the response/behavior
3. Evaluate the user experience
4. Identify any issues or surprises

### Phase 3: Structured Feedback Report

After experiencing all selected features, generate a report:

```markdown
## 🐕 Self-Experience Report

**Experience Time**: [Timestamp]
**Agent Version**: [from git log]
**Features Tested**: [Number] categories

---

### ✨ Highlights (What Worked Well)

| Feature | Why It's Good | User Feeling |
|---------|---------------|-------------|
| [Feature] | [Reason] | [Experience] |

---

### 🐛 Issues Found

| Issue | Severity | Reproduction | Suggested Fix |
|-------|----------|-------------|---------------|
| [Issue] | 🔴 High / 🟡 Medium / 🟢 Low | [Steps] | [Fix suggestion] |

---

### 💡 Improvement Suggestions

1. **[Suggestion Title]**
   - Current behavior: [What happens now]
   - Expected behavior: [What should happen]
   - Impact: [Who benefits and how]

---

### 🎭 User Experience Notes

- **First impression**: [How a new user would feel]
- **Confusion points**: [Where users might get stuck]
- **Delight moments**: [Surprisingly good experiences]

---

### 📋 Action Items

- [ ] [High priority fix]
- [ ] [Medium priority improvement]
- [ ] [Low priority enhancement]
```

### Phase 4: Deliver Report

**CRITICAL**: Always send the report to the user using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

If high-severity issues are found, also consider:
- Creating GitHub issues for bugs: `gh issue create --repo hs3180/disclaude --title "{title}" --body "{description}"`
- Notifying developers via the configured chatId

---

## Quality Guidelines

### Good Self-Experience Sessions:
- ✅ Covers diverse feature categories
- ✅ Tests both happy path and edge cases
- ✅ Evaluates from a real user's perspective
- ✅ Provides actionable feedback
- ✅ Identifies both issues and highlights
- ✅ Balances criticism with appreciation

### Avoid:
- ❌ Only testing predetermined scenarios
- ❌ Skipping error case testing
- ❌ Vague feedback without specific examples
- ❌ Only reporting problems (also report what works well)
- ❌ Testing features that are clearly documented as deprecated

---

## Checklist

- [ ] Discovered available features and recent changes
- [ ] Selected 3-5 features to experience
- [ ] Simulated diverse user interactions (including edge cases)
- [ ] Evaluated each feature from user perspective
- [ ] Generated structured feedback report
- [ ] **Sent report via send_user_feedback** (CRITICAL)
- [ ] Created issues for any high-severity bugs found

---

## DO NOT

- Only test predetermined happy paths
- Ignore error responses or edge cases
- Generate generic feedback without specific examples
- Create duplicate issues for known problems
- Skip the report delivery step
- Send reports to wrong chatId
- Include sensitive information in reports
