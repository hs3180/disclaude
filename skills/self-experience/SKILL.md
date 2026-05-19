---
name: self-experience
description: Self-experience (dogfooding) module - automatically explores own features from a new-user perspective, simulates diverse interactions, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Task
---

# Self-Experience (Dogfooding)

Automatically explore own features from a new-user perspective, simulate diverse interactions, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Running self-testing sessions to validate features work correctly
- Simulating new-user interactions to discover UX issues
- Generating structured feedback reports with findings and recommendations
- Periodic quality assurance through exploratory testing

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

---

## Execution Process

### Step 1: Discover Available Capabilities

Scan the codebase to understand what features and skills are available:

1. **List all skills**:
```bash
ls skills/
```

2. **Read each skill's description** (just the frontmatter):
```bash
head -5 skills/*/SKILL.md
```

3. **Identify testable features**: From the skill list, identify which features can be exercised through conversation or tool usage.

4. **Check available slash commands**: Look for user-invocable commands in the skill descriptions.

### Step 2: Plan Exploration Scenarios

Based on discovered capabilities, plan **3-5 diverse exploration scenarios**. Each scenario should simulate a different type of user interaction.

**Scenario categories** (choose from these, do NOT repeat the same type):

| Category | Example Interaction |
|----------|---------------------|
| **Feature invocation** | Call a specific skill or command |
| **Edge case** | Empty input, very long message, special characters |
| **Multi-turn conversation** | Ask follow-up questions, change topic mid-conversation |
| **Error recovery** | Trigger an error, see how well the system handles it |
| **Feature combination** | Use multiple features in sequence |
| **Vague request** | Make an ambiguous request like a real user might |
| **Multilingual** | Mix languages or use non-primary language |

**Planning template**:
```markdown
## Exploration Plan

### Scenario 1: [Category] — [Brief description]
- Input: [What to say/do]
- Expected: [What should happen]
- Actual: [To be filled during execution]

### Scenario 2: ...
```

### Step 3: Execute Explorations

For each planned scenario, simulate the interaction **from a new-user perspective**:

1. **Act like a first-time user** — don't assume knowledge of internal architecture
2. **Use natural language** — phrase requests as a non-technical user would
3. **Observe the response** — note quality, accuracy, helpfulness, speed
4. **Record the result** — document what happened vs what was expected

**For each scenario, record**:
- Input sent
- Response received (summary)
- Whether it worked as expected
- Any issues or surprises encountered
- Subjective quality rating (1-5)

### Step 4: Generate Feedback Report

Compile all findings into a structured report:

```markdown
# Self-Experience Report

**Date**: [Today's date]
**Version**: [From package.json version]
**Scenarios Tested**: [count]

---

## Summary

| Metric | Value |
|--------|-------|
| Scenarios passed | X/Y |
| Issues found | N |
| UX observations | N |
| Overall quality | [Good/Fair/Needs Work] |

---

## Scenario Results

### Scenario 1: [Name]
- **Category**: [Category type]
- **Input**: "[What was sent]"
- **Result**: [Pass/Partial/Fail]
- **Response quality**: [1-5]
- **Notes**: [Observations]

### Scenario 2: [Name]
...

---

## Issues Found

| # | Severity | Description | Reproduction |
|---|----------|-------------|--------------|
| 1 | [High/Medium/Low] | [Issue description] | [How to reproduce] |

---

## UX Observations

1. [Observation about user experience]
2. [Observation about response quality]
3. [Observation about discoverability]

---

## Recommendations

1. [Actionable improvement suggestion]
2. [Actionable improvement suggestion]

---

## Highlights

1. [Something that worked well]
2. [Something that surprised positively]
```

### Step 5: Deliver Report

Write the report to `workspace/self-experience-report-{date}.md` and present a summary to the user.

If the Chat ID is available, send a concise summary card with key findings.

---

## Quality Guidelines

### Good self-experience sessions:
- Cover at least 3 different feature areas
- Include at least 1 edge case scenario
- Include at least 1 "vague request" scenario
- Report both positive and negative findings
- Provide actionable recommendations

### Avoid:
- Only testing "happy path" scenarios
- Skipping the exploration and generating a generic report
- Reporting only problems without noting what works well
- Being overly technical — think like a real user

---

## DO NOT

- Submit issues automatically (just report findings)
- Make destructive changes to the system
- Access or expose sensitive configuration (API keys, secrets)
- Run indefinitely — limit to the planned scenarios
- Skip the exploration phase and fabricate results
