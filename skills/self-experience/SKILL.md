---
name: self-experience
description: Self-experience (dogfooding) module - automatically explores own features from a new-user perspective, simulates diverse interactions, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验".
allowed-tools: Read, Glob, Grep, Bash, WebSearch, send_user_feedback
---

# Self-Experience (Dogfooding)

Automatically explore disclaude's own features from a new-user perspective, simulate diverse interactions, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Periodic self-testing of bot capabilities from a new-user perspective
- Simulating diverse user interactions to discover UX issues
- Generating structured feedback on feature quality
- Validating that core features work end-to-end
- Discovering edge cases and integration problems

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验", "体验报告"

## Core Principle

**Use prompt-based simulation, NOT complex program modules.**

The LLM acts as a "new user" and simulates diverse interactions by analyzing the bot's available skills, features, and recent behavior. It generates a structured report of findings, including issues discovered, UX friction points, and improvement suggestions.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Self-Experience Process

### Step 1: Discover Available Capabilities

Catalog the bot's current capabilities by examining available skills and features.

**Actions:**
1. List all available skills: `Glob skills/*/SKILL.md`
2. List all active schedules: `Glob workspace/schedules/*.md`
3. Check recent chat history: `Read workspace/chat/{chatId}.md` (last 200 lines)
4. Review available slash commands from skill names

### Step 2: Select Experience Scenarios

Based on the discovered capabilities, select 3-5 diverse experience scenarios that cover different aspects of the bot. Prioritize scenarios that:

| Priority | Scenario Type | Example |
|----------|---------------|---------|
| High | Core feature validation | "Can the bot correctly process a basic chat message?" |
| High | Skill invocation | "Does /feedback work end-to-end?" |
| Medium | Edge case exploration | "How does the bot handle very long input?" |
| Medium | Multi-feature combination | "Can scheduled tasks + skills work together?" |
| Low | UX polish check | "Are responses well-formatted and clear?" |

**Scenario Selection Rules:**
- Cover at least 3 different skill categories
- Include at least 1 edge case scenario
- Focus on features that users actually use (check chat history for frequency)
- Rotate focus areas across different runs (check recent self-experience reports to avoid repetition)

### Step 3: Simulate Interactions

For each selected scenario, simulate the interaction as a new user:

1. **Define the user persona**: Choose a persona (e.g., first-time user, power user, non-technical user)
2. **Write the simulated input**: What would this user say/ask?
3. **Trace the expected bot behavior**: What should the bot do?
4. **Identify potential friction points**: Where might the user get confused or stuck?
5. **Note actual behavior**: Compare expected vs. observed (from chat history/logs if available)

**Simulation Template per Scenario:**

```markdown
### Scenario: [Name]
- **Persona**: [User type]
- **Simulated Input**: "[What the user would say]"
- **Expected Behavior**: [What should happen]
- **Potential Issues**: [What could go wrong]
- **Severity**: [Critical / Major / Minor / Suggestion]
- **Details**: [Detailed analysis]
```

### Step 4: Analyze Recent Real Interactions

Examine recent chat logs to find real-world issues:

1. Read recent logs from `workspace/logs/` (last 3-7 days)
2. Look for:
   - User confusion or repeated questions
   - Bot errors or failures
   - Abandoned conversations (user stopped responding)
   - Corrections or frustration from users
   - Feature requests embedded in conversations

3. Correlate findings with simulated scenarios

### Step 5: Generate Feedback Report

Create a structured report with the following format:

```markdown
## 🧪 Self-Experience Report (Dogfooding)

**Date**: [ISO 8601 date]
**Scenarios Tested**: [Number]
**Issues Found**: [Number]
**Overall Health**: [Excellent / Good / Needs Attention / Poor]

---

### Summary

[Brief 2-3 sentence overview of the bot's current state from a user perspective]

---

### Issues Discovered

#### Critical
| # | Issue | Scenario | Impact |
|---|-------|----------|--------|
| 1 | [Description] | [Scenario name] | [User impact] |

#### Major
| # | Issue | Scenario | Impact |
|---|-------|----------|--------|
| 1 | [Description] | [Scenario name] | [User impact] |

#### Minor
| # | Issue | Scenario | Impact |
|---|-------|----------|--------|
| 1 | [Description] | [Scenario name] | [User impact] |

---

### UX Observations

1. **[Observation Title]**: [Description]
   - Evidence: [From simulation or real logs]
   - Suggestion: [How to improve]

---

### Feature Coverage

| Skill / Feature | Status | Notes |
|----------------|--------|-------|
| [Skill name] | Tested / Partially tested / Not tested | [Observations] |

---

### Recommendations

1. **[Priority: High]** [Actionable recommendation]
2. **[Priority: Medium]** [Actionable recommendation]
3. **[Priority: Low]** [Actionable recommendation]

---

*Report generated by self-experience skill | Run #{run_number if trackable}*
```

### Step 6: Send Report

**CRITICAL**: Always send the report to the user using `send_user_feedback`.

```
send_user_feedback({
  content: [The report in markdown format],
  format: "text",
  chatId: [The chatId from context]
})
```

---

## Scenario Idea Bank

To ensure diversity across runs, here are scenario categories to rotate through:

### Core Interaction Scenarios
- Basic greeting and introduction
- Asking for help or usage guidance
- Sending a long, multi-paragraph message
- Using mixed languages (Chinese + English)
- Sending empty or minimal input (single character)
- Asking ambiguous questions with multiple interpretations

### Skill-Specific Scenarios
- Invoking each available slash command
- Testing skill with missing arguments
- Testing skill with invalid arguments
- Combining multiple skills in sequence

### Scheduled Task Scenarios
- Checking schedule status
- Creating a new schedule
- Understanding schedule output

### Error Recovery Scenarios
- How does the bot handle unrecognized commands?
- What happens when a skill fails mid-execution?
- How does the bot recover from network issues (visible in logs)?

### Edge Case Scenarios
- Very long input (> 2000 characters)
- Rapid successive messages
- Messages with special characters or formatting
- Messages with code blocks
- Messages with URLs
- Messages with @ mentions of the bot

---

## Avoiding Repetition

To prevent generating the same report every run:

1. **Check for previous reports** in `workspace/chat/{chatId}.md` before generating
2. **Rotate scenario focus**: If the last report focused on skill invocation, focus on edge cases or error recovery this time
3. **Vary personas**: Alternate between first-time user, power user, and non-technical user perspectives
4. **Reference recent changes**: If there are new skills or features (check git log), prioritize testing those

---

## Example

### Input (scheduled execution):
```
Weekly self-experience check — explore bot features from a new-user perspective.
```

### Process:
1. Catalog: 19 skills available, 3 active schedules
2. Select: 4 scenarios (basic chat, /feedback skill, edge case: long input, schedule inquiry)
3. Simulate each with different personas
4. Analyze recent 3 days of logs
5. Generate report

### Output (Report Excerpt):
```markdown
## Self-Experience Report (Dogfooding)

**Date**: 2026-05-11
**Scenarios Tested**: 4
**Issues Found**: 3
**Overall Health**: Good

### Issues Discovered

#### Major
| # | Issue | Scenario | Impact |
|---|-------|----------|--------|
| 1 | /feedback skill does not validate input length | Skill invocation | Users may submit very long feedback that gets truncated |

#### Minor
| # | Issue | Scenario | Impact |
|---|-------|----------|--------|
| 1 | No confirmation after skill execution | Basic chat | Users unsure if action completed |

### Recommendations
1. **[High]** Add input validation to /feedback skill
2. **[Medium]** Add completion confirmations for all skills
```

---

## Integration with Other Skills

- **feedback**: If critical issues are found, suggest submitting via /feedback
- **daily-chat-review**: Use chat review data to supplement self-experience findings
- **schedule-recommend**: If self-experience runs are useful, recommend scheduling them
- **skill-creator**: If new skill ideas emerge from dogfooding, suggest creating them

---

## Checklist

- [ ] Cataloged all available skills and features
- [ ] Selected 3-5 diverse experience scenarios
- [ ] Simulated each scenario with a defined persona
- [ ] Analyzed recent real chat logs for corroborating evidence
- [ ] Generated structured feedback report
- [ ] Checked for repetition with previous reports
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Actually invoke skills during simulation (this is analysis only, not live testing)
- Include sensitive user data in reports (sanitize chat IDs, user IDs)
- Generate identical reports across runs (rotate scenarios and personas)
- Skip the send_user_feedback step
- Submit GitHub issues automatically (suggest them as recommendations instead)
- Create schedules or modify configurations based on findings (report only)
