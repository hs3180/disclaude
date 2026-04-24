---
name: dogfood
description: Self-experience (dogfooding) specialist - automatically explores disclaude capabilities from a new user perspective, simulates real usage scenarios, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfood", "自动体验", "功能测试", "self-experience", "capability check". Triggered by scheduler for automated periodic execution.
allowed-tools: Read, Glob, Grep, Bash, WebSearch
---

# Dogfood — Self-Experience & Feedback

Automatically experience disclaude's own capabilities from a "new user" perspective, simulate real usage scenarios, and generate structured feedback.

## When to Use This Skill

**Use this skill for:**
- Automated self-experience after new version deployment
- Proactive capability verification
- UX quality assessment from a user perspective
- Discovering integration issues across features

**Keywords that trigger this skill**: "自我体验", "dogfood", "自动体验", "功能测试", "self-experience", "capability check"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-driven exploration, NOT scripted test cases.**

The agent should think and act like a curious new user, exploring features organically and noting real observations — not mechanically checking boxes.

---

## Self-Experience Process

### Step 1: Discover Available Capabilities

Read the skills directory to understand what features are available:

```bash
# List all available skills
ls skills/

# Read a few skill descriptions to understand capabilities
head -5 skills/*/SKILL.md
```

For each skill, note:
- **Name**: The skill identifier
- **Description**: What it does (from the YAML frontmatter)
- **Allowed tools**: What tools it can use
- **Trigger conditions**: How users invoke it

### Step 2: Select Exploration Activities

Based on discovered capabilities, **autonomously select 2-3 activities** to experience. Prioritize variety:

| Activity Type | Examples |
|---------------|----------|
| **Skill invocation** | Try calling a skill with a realistic user query |
| **Multi-skill interaction** | Chain multiple skills together (e.g., feedback → issue creation) |
| **Edge case exploration** | Test with unusual inputs, empty requests, ambiguous queries |
| **Cross-feature integration** | Verify skills work together correctly |
| **Documentation check** | Read SKILL.md files and verify instructions are clear |

**Selection criteria**:
- Don't repeat the same activity twice in a row
- Prefer activities not tested in previous sessions
- Mix simple and complex scenarios
- Include at least one "new user" scenario (first-time usage)

### Step 3: Simulate User Experience

For each selected activity, simulate a realistic user interaction:

**Simulation approach**:
1. **Adopt a persona**: Think as a specific type of user (developer, non-technical user, first-time user, power user)
2. **Formulate a natural query**: What would this user actually say?
3. **Observe the response**: Would a real user understand this? Is it helpful?
4. **Note observations**: Record what worked well, what was confusing, what could be improved

**Example simulation**:
```
Persona: First-time developer user
Query: "I want to create a schedule that runs every morning"
Expected: Clear guidance on how to set up a schedule
Observation: The instructions in SKILL.md are clear, but the schedule frontmatter format could be documented better
```

### Step 4: Generate Feedback Report

After completing all activities, generate a structured report:

```markdown
## 🐕 Disclaude Self-Experience Report

**Experience Date**: [ISO 8601 timestamp]
**Version**: [from package.json if available]
**Activities Tested**: [Number]
**Persona**: [Types of users simulated]

---

### ✅ What Worked Well

#### [Feature/Activity Name]
- **Scenario**: [What was tested]
- **Observation**: [What went well]
- **User Impact**: [Why this matters]

---

### ⚠️ Areas for Improvement

#### [Issue Title]
- **Severity**: 🔴 High / 🟡 Medium / 🟢 Low
- **Scenario**: [What was being done]
- **Issue**: [What went wrong or could be better]
- **Suggestion**: [How to fix or improve]

---

### 🆕 Feature Discoveries

#### [Feature Name]
- **Description**: [New capability discovered during exploration]
- **Potential Use Case**: [How users might benefit]

---

### 📊 Summary

| Category | Count |
|----------|-------|
| Activities tested | X |
| Worked well | X |
| Improvements needed | X |
| New discoveries | X |
| Critical issues | X |

---

### 🎯 Recommended Actions

1. [High priority action]
2. [Medium priority action]
3. [Low priority action / observation]

---
*This report was generated automatically by the disclaude dogfood skill.*
```

### Step 5: Deliver Feedback

**Always send the report using `send_user_feedback`:**

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

**Optionally submit critical findings as GitHub Issues:**

Only create GitHub Issues for findings with **🔴 High severity**. Use the `gh` CLI:

```bash
gh issue create --repo hs3180/disclaude \
  --title "[dogfood] Brief description of the finding" \
  --body "## Source

Auto-detected during self-experience (dogfood) on [date].

## Observation

[Detailed description of what was found]

## Steps to Reproduce

1. [Step 1]
2. [Step 2]

## Expected Behavior

[What should happen]

## Actual Behavior

[What actually happened]

## Suggested Fix

[How to resolve this issue]

---
*Auto-generated by disclaude dogfood skill*" \
  --label "enhancement"
```

**⚠️ Important**: Do NOT create issues for minor observations or low-severity findings. Only submit issues for clear, reproducible problems that would impact real users.

---

## Experience Diversity Guidelines

### Persona Rotation

Rotate between different user personas to get diverse perspectives:

| Persona | Focus Areas |
|---------|-------------|
| **New user** | First-time setup, discoverability, clarity |
| **Developer** | Technical accuracy, API usability, code quality |
| **Power user** | Advanced features, efficiency, customization |
| **Non-technical user** | Simplicity, error messages, guidance |

### Activity Categories

Ensure coverage across these categories over multiple sessions:

- Skill invocation and response quality
- Error handling and recovery
- Documentation accuracy
- Integration between features
- Performance and responsiveness
- Edge cases and unusual inputs

---

## Historical Tracking

To avoid repeating the same activities, check previous dogfood sessions:

```bash
# Check if previous dogfood reports exist
ls workspace/logs/*dogfood* 2>/dev/null || echo "No previous sessions"
```

If previous sessions exist, read the last report to understand what was already tested, and **select different activities**.

---

## DO NOT

- Create scripted test cases (this is organic exploration, not automated testing)
- Submit GitHub Issues for minor observations or cosmetic issues
- Test the same activity repeatedly across sessions
- Interact with real external services (APIs, websites) during simulation
- Modify any project files during the experience
- Create or modify schedules during the experience
- Skip the report generation step
- Send feedback to the wrong chatId
- Include sensitive information in reports or issues
