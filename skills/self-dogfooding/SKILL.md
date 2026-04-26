---
name: self-dogfooding
description: Self-dogfooding specialist - automatically explores and tests the agent's own features with simulated user personas, generates structured quality reports. Use for automated self-testing, dogfooding, quality assurance, or when user says keywords like "自我体验", "dogfooding", "自测试", "体验最新版本", "self-test", "自动测试".
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Self-Dogfooding

Automatically explore and test the agent's own features using simulated user personas, generating structured quality feedback reports.

## When to Use This Skill

**Use this skill for:**
- Periodic self-testing of available skills and features
- Generating dogfooding reports after version updates
- Quality assurance through simulated user interactions
- Discovering UX issues that fixed test cases cannot catch

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自测试", "体验最新版本", "self-test", "自动测试", "dog food"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-driven exploration, NOT pre-scripted test cases.**

The LLM acts as a simulated user, freely exploring features based on the current state of the codebase. This approach mirrors real user behavior more closely than automated tests.

---

## Exploration Process

### Step 1: Inventory Available Capabilities

Scan the codebase to discover all available skills, schedules, and features:

1. **List all skills**:
```bash
ls skills/*/SKILL.md
```

2. **Read each skill's frontmatter** (name, description, allowed-tools):
   - Use `Read` on each `SKILL.md` file
   - Extract the skill name, description, and tools

3. **Check changelog for recent changes**:
   - Read `CHANGELOG.md` (first 100 lines)
   - Note newly added features and changes

4. **List available schedules**:
```bash
ls schedules/ examples/schedules/
```

### Step 2: Select Exploration Targets

Based on the inventory, select **2-3 features** to explore. Selection criteria:

| Priority | Selection Reason | Example |
|----------|-----------------|---------|
| **Highest** | New features (from CHANGELOG) | Skills added in latest version |
| **High** | Complex features with multiple paths | Skills with branching logic |
| **Medium** | Frequently used features | Core interaction flows |
| **Low** | Stable, well-tested features | Long-standing unchanged skills |

**Selection Rules**:
- Prefer variety — select features from different categories
- Include at least one recently added/changed feature if available
- Do NOT select the self-dogfooding skill itself (avoid recursion)
- Vary selections across runs to ensure coverage over time

### Step 3: Simulate User Interactions

For each selected feature, simulate a **realistic user interaction**:

1. **Choose a user persona** (rotate across runs):
   - **New user**: Unfamiliar with the system, asks basic questions
   - **Power user**: Knows shortcuts, tries edge cases
   - **Non-technical user**: Uses natural language, may be imprecise
   - **Frustrated user**: Has encountered an issue, seeking help

2. **Generate 3-5 test scenarios** for the feature:
   - Normal/happy path usage
   - Edge case (empty input, very long input, special characters)
   - Error recovery (what happens after a failure)
   - Cross-feature interaction (using this feature with another)

3. **Evaluate each scenario** (simulate the interaction in your mind):
   - Would the skill handle this input correctly?
   - Is the response clear and helpful?
   - Are there potential failure points?
   - Would a real user be satisfied?

### Step 4: Generate Dogfooding Report

Create a structured report:

```markdown
## Dogfooding Report

**Date**: [Current date]
**Version**: [From CHANGELOG.md or package.json]
**Explorer Persona**: [Selected persona]
**Features Tested**: [List of tested features]

---

### Summary

| Dimension | Score | Notes |
|-----------|-------|-------|
| Response Quality | [1-5] | [Brief note] |
| Error Handling | [1-5] | [Brief note] |
| User Experience | [1-5] | [Brief note] |
| Feature Completeness | [1-5] | [Brief note] |

---

### Feature 1: [Name]

**Test Scenarios**:

#### Scenario 1.1: [Description]
- **Persona**: [Which persona was used]
- **Simulated Input**: [What the user would say/do]
- **Expected Behavior**: [What should happen]
- **Assessment**: [PASS / WARN / FAIL]
- **Notes**: [Observations]

#### Scenario 1.1: [Description]
- ...

**Feature Assessment**:
- **Strengths**: [What works well]
- **Issues Found**: [Problems discovered]
- **Suggestions**: [How to improve]

---

### Feature 2: [Name]
...

---

### Overall Findings

#### Highlights
- [Things that work well]

#### Issues Discovered
- [List of issues with severity]

#### Improvement Suggestions
1. **[Priority]** [Suggestion]
2. **[Priority]** [Suggestion]

---

### Recommended Actions

1. **Immediate**: [Issues that should be fixed soon]
2. **Planned**: [Improvements to schedule]
3. **Observation**: [Things to monitor]
```

### Step 5: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Quality Guidelines

### Good Dogfooding Reports:
- Test realistic scenarios users would encounter
- Cover both happy paths and edge cases
- Provide actionable, specific feedback
- Vary personas and features across runs
- Score honestly — not everything should be 5/5

### Avoid:
- Only testing happy paths
- Generic feedback without specifics
- Skipping error scenarios
- Recursion (testing self-dogfooding itself)
- Spending too long on one feature (time-box each to ~5 min)

---

## Persona Details

### New User Persona
- Asks "what can you do?"
- Uses natural language, not commands
- May misspell or use vague terms
- Tests onboarding experience

### Power User Persona
- Uses slash commands and shortcuts
- Tries to combine multiple features
- Tests edge cases and limits
- Looks for hidden capabilities

### Non-Technical User Persona
- Avoids technical jargon
- Asks follow-up questions
- May not understand error messages
- Values simplicity over power

### Frustrated User Persona
- Starts with a complaint or problem
- May be impatient
- Tests error recovery paths
- Needs clear, empathetic responses

---

## Scoring Guide

| Score | Meaning | Criteria |
|-------|---------|----------|
| 5 | Excellent | Feature works flawlessly, great UX, handles edge cases |
| 4 | Good | Works well, minor issues that don't impact usability |
| 3 | Acceptable | Works for common cases, some rough edges |
| 2 | Needs Work | Basic functionality works but has notable issues |
| 1 | Broken | Core functionality is broken or unusable |

---

## Schedule Configuration

To enable periodic self-dogfooding, create a schedule file:

```markdown
---
name: "Weekly Self-Dogfooding"
cron: "0 11 * * 1"
enabled: true
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
---

Please use the self-dogfooding skill to explore and test the agent's own features.

Requirements:
1. Read all skill files from skills/*/SKILL.md
2. Check CHANGELOG.md for recent changes
3. Select 2-3 features to test (prefer recently changed ones)
4. Simulate user interactions with different personas
5. Generate a structured dogfooding report
6. Send the report using send_user_feedback
```

---

## Checklist

- [ ] Listed all available skills from `skills/*/SKILL.md`
- [ ] Checked `CHANGELOG.md` for recent changes
- [ ] Selected 2-3 features to explore (varied categories)
- [ ] Chose a user persona for this run
- [ ] Simulated 3-5 scenarios per feature
- [ ] Evaluated each scenario (PASS/WARN/FAIL)
- [ ] Generated structured report with scores
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Test the self-dogfooding skill itself (avoid recursion)
- Only test happy paths — edge cases matter
- Generate generic reports without specific observations
- Spend more than ~15 minutes total on exploration
- Skip the send_user_feedback step
- Score everything 5/5 — honest assessment is valuable
