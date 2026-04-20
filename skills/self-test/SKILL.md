---
name: self-test
description: Dogfooding self-test specialist - automatically tests disclaude's own capabilities by simulating diverse user interactions, detecting issues, and generating structured feedback reports. Use when user says keywords like "自测", "dogfood", "self-test", "体验测试", "自动测试", "版本验证". Triggered by scheduler for automated post-deployment verification.
allowed-tools: Read, Write, Bash, Glob, Grep, send_user_feedback
---

# Self-Test (Dogfooding) Skill

Automatically test disclaude's own capabilities by simulating diverse user personas and interaction patterns, then generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Post-deployment verification after new version release
- Automated capability testing across skills and features
- Simulating diverse user interaction patterns
- Generating quality feedback for continuous improvement
- Manual self-test when user says "自测" or "dogfood"

**Keywords that trigger this skill**: "自测", "dogfood", "self-test", "体验测试", "自动测试", "版本验证", "自我体验"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

---

## Core Principle

**Simulate real user interactions from diverse perspectives, not preset test scripts.**

Each test session adopts a randomly selected persona and explores capabilities organically, just as a real user would — asking questions, trying features, and encountering edge cases naturally.

---

## Test Execution Process

### Step 1: Gather Context

Collect information about the current state:

```bash
# Current version
cat package.json | grep '"version"'

# Recent changes (last 10 commits)
git log --oneline -10

# Available skills
ls skills/

# Available schedules
ls schedules/
```

### Step 2: Select Test Persona

Randomly pick ONE persona for this session from the list below. **Do NOT test all personas in a single run.**

| Persona ID | Name | Behavior | Focus Areas |
|------------|------|----------|-------------|
| P1 | Curious Newcomer | Asks basic questions, explores features naively | Onboarding experience, help messages, default behavior |
| P2 | Power User | Tests advanced features, tries edge cases | Skill invocation, complex queries, multi-step workflows |
| P3 | Non-technical User | Uses natural language, makes typos, asks vague questions | Intent understanding, error recovery, tolerance |
| P4 | Developer | Asks about code, architecture, and technical details | Technical accuracy, code-related skills |
| P5 | Reporter | Requests summaries, analyses, and reports | Data processing, formatting, report generation |

**Selection rule**: Use the current minute of the hour modulo 5 as the persona index (P1=0, P2=1, ... P5=4). This ensures rotation across scheduled runs.

### Step 3: Design Test Scenarios

Based on the selected persona, design 3-5 specific test scenarios. Each scenario should:

1. **Have a clear objective** — what capability is being tested
2. **Simulate a real user message** — the input the persona would send
3. **Define expected behavior** — what a correct response looks like
4. **Include edge cases** — unusual inputs relevant to the persona

**Scenario template:**
```
Scenario: [Name]
Objective: [What to test]
User Input: "[Simulated message]"
Expected: [What should happen]
Edge Case: [Unusual variation to try]
```

### Step 4: Execute Test Scenarios

For each scenario, **actually perform the interaction** and record results:

1. **Send the simulated message** as if you are the user
2. **Observe the response** — check against expected behavior
3. **Test the edge case** — try the unusual variation
4. **Record the outcome**:
   - ✅ PASS — Response matches expected behavior
   - ⚠️ PARTIAL — Mostly correct but has issues
   - ❌ FAIL — Incorrect, broken, or missing response
   - 🔍 NOTED — Interesting observation worth reporting

### Step 5: Generate Self-Test Report

Create a structured report following this format:

```markdown
## 🐕 Dogfooding Self-Test Report

**Test Time**: [ISO 8601 timestamp]
**Version**: [Current version from package.json]
**Persona**: [Selected persona name and ID]
**Recent Changes**: [Summary of last 3-5 commits]

---

### Test Results Summary

| Scenario | Objective | Result | Details |
|----------|-----------|--------|---------|
| [Name] | [Objective] | ✅/⚠️/❌ | [Brief note] |

### Detailed Findings

#### ✅ Working Well
- [List of things that worked correctly]
- [Notable positive experiences]

#### ⚠️ Issues Found
- **[Issue Title]**: [Description]
  - Severity: [Low/Medium/High]
  - Reproduction: [How to reproduce]
  - Suggestion: [How to fix]

#### 🔍 Observations
- [Interesting behaviors noticed]
- [Potential improvements]
- [Comparison with previous versions if applicable]

### Persona Experience Notes
[How the selected persona would rate the experience, from their perspective]

---

### Recommendations

1. **[Priority]**: [Recommendation with specific action]
2. **[Priority]**: [Recommendation with specific action]

---

*Report generated by self-test skill | Persona: [name] | Disclaude v[version]*
```

### Step 6: Deliver Report

**CRITICAL**: Always send the report to the user via `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The full report in markdown]
- format: "text"
- chatId: [The chatId from context]
```

### Step 7: Submit Issues (Optional)

If **High severity** issues are found during testing:

1. Use the `gh` CLI to create issues for critical problems
2. Apply appropriate labels (`bug` for failures, `enhancement` for improvements)
3. Reference the self-test report in the issue body
4. Report the issue numbers back to the user

**Only submit issues for High severity problems.** Medium/Low issues should be listed in the report for manual review.

---

## Test Coverage Areas

Each persona should cover a different subset of these areas:

| Area | Description | Tested by |
|------|-------------|-----------|
| Basic conversation | Greetings, Q&A, general chat | P1, P3 |
| Skill invocation | `/feedback`, `/schedule`, etc. | P2 |
| Error handling | Invalid input, edge cases | P2, P3 |
| Technical accuracy | Code questions, architecture | P4 |
| Output quality | Formatting, completeness | P5 |
| Multilingual | Chinese/English mixed input | P3 |
| Long input | Extended messages, large content | P2 |
| Feature discovery | Finding and using features | P1 |
| Recovery | After errors, unclear responses | P3 |

---

## Quality Criteria

When evaluating responses, consider these dimensions:

| Dimension | Weight | Good (✅) | Acceptable (⚠️) | Poor (❌) |
|-----------|--------|-----------|-----------------|-----------|
| Accuracy | 30% | Factually correct | Minor inaccuracies | Wrong information |
| Completeness | 20% | Fully addresses request | Mostly complete | Missing key parts |
| Clarity | 20% | Clear and well-structured | Understandable | Confusing or vague |
| Responsiveness | 15% | Timely and appropriate | Slight delay or off-topic | Slow or irrelevant |
| Error Recovery | 15% | Graceful handling | Recovers with help | Crashes or loops |

---

## Scheduling Integration

This skill is designed to work with the scheduler system. A recommended schedule:

```yaml
# schedules/self-test.md
cron: "0 10 * * 1"  # Every Monday at 10:00
enabled: true
blocking: true
```

When triggered by schedule, the skill runs autonomously and sends the report to the configured chatId.

---

## Anti-Patterns (DO NOT)

- ❌ Run all personas in a single session (one per run)
- ❌ Create preset test scripts (each run should be organic)
- ❌ Skip the report generation step
- ❌ Submit issues for Low severity findings (list in report only)
- ❌ Include sensitive data (user IDs, tokens) in reports
- ❌ Test features that require external services you cannot access
- ❌ Generate excessively long reports (keep under 2000 words)

---

## Example Session

### Input (Triggered by schedule):
```
Chat ID: oc_example123
Message ID: cli-abc456
```

### Execution:

1. **Gather context**: Version 0.4.0, recent commits show new card formatting features
2. **Select persona**: P1 (Curious Newcomer) — current minute % 5 = 0
3. **Design scenarios**:
   - Ask "你好，你能做什么？"
   - Try sending an empty message
   - Ask for help in mixed Chinese/English
   - Request a summary of recent changes
   - Ask a follow-up question about a previous response
4. **Execute and record**: Each scenario gets a pass/fail/partial rating
5. **Generate report**: Structured markdown with findings
6. **Send report**: Via send_user_feedback to the chatId

### Output (Report excerpt):
```markdown
## 🐕 Dogfooding Self-Test Report

**Test Time**: 2026-04-21T10:00:00Z
**Version**: 0.4.0
**Persona**: P1 - Curious Newcomer

### Test Results Summary
| Scenario | Result | Details |
|----------|--------|---------|
| Greeting & capabilities | ✅ | Clear, friendly response |
| Empty message handling | ⚠️ | Responds but could be more helpful |
| Mixed language help | ✅ | Understood both languages |
| Recent changes summary | ✅ | Accurate and well-formatted |
| Follow-up question | ❌ | Lost context from previous exchange |

### Recommendations
1. **High**: Improve empty message handling — suggest available commands
2. **Medium**: Add context retention hint for follow-up questions
```
