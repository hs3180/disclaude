---
name: self-test
description: "Self-testing (dogfooding) specialist — automatically explores and tests disclaude's own features as a new user. Generates structured reports with findings and improvement suggestions. Use when user says keywords like '自我测试', 'dogfooding', '自测', '体验', 'self-test', 'self review', 'auto test', 'quality check'."
allowed-tools: Read, Glob, Grep, Bash, WebSearch
---

# Self-Test (Dogfooding)

Automatically explore and test disclaude's own features from a new user's perspective, generating structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Periodic self-testing of available features and skills
- Post-deployment verification of system health
- Exploratory testing from a new user's perspective
- Generating quality reports with improvement suggestions

**Keywords that trigger this skill**: "自我测试", "dogfooding", "自测", "体验测试", "self-test", "self review", "auto test", "quality check", "体验最新版本"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Act as a curious new user exploring the system for the first time.**

Do NOT follow a rigid checklist. Instead, adopt a persona of a first-time user who:
- Doesn't know the jargon or internals
- Tries things intuitively, sometimes incorrectly
- Cares about clarity, helpfulness, and ease of use
- Notices rough edges that developers might overlook

---

## Self-Test Process

### Phase 1: Environment Discovery

Gather system context before generating test scenarios.

#### 1.1 Version & Changelog

```bash
# Read the latest version info
head -50 CHANGELOG.md
```

Identify:
- Current version number
- Recently added/changed features
- Known fixes in this release

#### 1.2 Skill Inventory

```bash
# List all available skills
ls skills/
```

For each skill, read its description:

```bash
# Read skill frontmatter for quick overview
for skill in skills/*/SKILL.md; do
  echo "=== $(basename $(dirname $skill)) ==="
  head -5 "$skill"
  echo ""
done
```

#### 1.3 Configuration Overview

```bash
# Check available config (without exposing secrets)
ls disclaude.config.example.yaml
cat disclaude.config.example.yaml | head -100
```

Understand what features are configurable and how.

### Phase 2: Scenario Generation

Based on the discovery in Phase 1, **creatively generate** 5-8 test scenarios. Do NOT use a fixed list — adapt to what you discover.

**Scenario generation guidelines:**

| Category | Examples | What to evaluate |
|----------|----------|-----------------|
| **Basic interaction** | Greeting, simple question, help request | Response quality, tone, helpfulness |
| **Skill invocation** | Try each major skill with realistic input | Whether skill activates correctly, output quality |
| **Edge cases** | Empty input, very long input, mixed languages, special characters | Error handling, graceful degradation |
| **Multi-turn** | Ask follow-up questions, correct the agent, change topic mid-conversation | Context retention, adaptability |
| **Ambiguous requests** | Vague questions, underspecified tasks | Clarification behavior, reasonable assumptions |
| **Error recovery** | Provide invalid input, ask for non-existent features | Error messages, alternative suggestions |
| **Cross-skill** | Combine multiple skills in one session | Integration quality, context passing |
| **Documentation** | Ask "how do I..." questions about the system | Self-documentation quality |

**IMPORTANT**: Scenarios should feel like real user interactions, not unit tests. Write them in natural language.

### Phase 3: Execute Scenarios

For each scenario, simulate the interaction and record observations:

```
### Scenario: {name}
**Persona**: {brief persona description}
**Input**: {what the user says/does}
**Expected behavior**: {what should happen ideally}
**Actual observation**: {what actually happens during exploration}
**Rating**: {1-5 stars}
**Issues found**: {list of issues, if any}
**Improvement suggestions**: {list of suggestions}
```

**Execution approach**:
- Read relevant skill files to understand expected behavior
- Check if the skill's documentation is clear enough for a new user
- Verify the skill's described workflow makes logical sense
- Test edge cases by examining how the code would handle them
- For skills with scripts, check if scripts exist and are syntactically valid

**Note**: Since this runs within the agent itself, full end-to-end testing of interactive features is limited. Focus on:
1. **Documentation quality** — Is the skill self-explanatory?
2. **Workflow logic** — Do the steps make sense?
3. **Error handling** — Are edge cases addressed?
4. **Consistency** — Do skills follow the same patterns?
5. **Completeness** — Are required files present and non-empty?

### Phase 4: Generate Report

Compile findings into a structured report:

```markdown
# Self-Test Report

**Generated**: [ISO timestamp]
**Version**: [from CHANGELOG.md]
**Scenarios tested**: [count]

---

## Executive Summary

[2-3 sentence overall assessment]

**Overall Rating**: {1-5} / 5

---

## Test Results

| # | Scenario | Rating | Status |
|---|----------|--------|--------|
| 1 | {name} | {1-5} | PASS / ISSUES / FAIL |
| ... | ... | ... | ... |

---

## Findings

### Critical Issues
[Issues that significantly impact user experience]

### Improvements
[Suggestions for enhancement]

### Highlights
[Things that work well — important for morale!]

---

## Detailed Observations

### Scenario 1: {name}
[Full details from Phase 3]

### Scenario 2: {name}
[Full details from Phase 3]

...

---

## Recommendations

1. **Immediate**: [Must-fix items]
2. **Short-term**: [Should-fix items]
3. **Long-term**: [Nice-to-have improvements]
```

### Phase 5: Deliver Report

**CRITICAL**: Send the report to the user via `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The full report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Quality Criteria

When evaluating features, use these criteria:

| Criterion | 5 stars (Excellent) | 3 stars (Acceptable) | 1 star (Poor) |
|-----------|---------------------|----------------------|---------------|
| **Documentation** | Clear, comprehensive, with examples | Adequate but could be clearer | Missing or confusing |
| **Error handling** | Graceful with helpful messages | Basic handling, generic errors | Crashes or silent failures |
| **User experience** | Intuitive, delightful | Works but requires learning | Frustrating or broken |
| **Completeness** | All features working as described | Core features work, some gaps | Missing or broken features |
| **Consistency** | Follows established patterns | Mostly consistent | Inconsistent or idiosyncratic |

---

## Scenario Inspiration

These are NOT fixed scenarios — adapt based on what you discover:

### New User Onboarding
> "I just started using disclaude. What can it do?"

### Feature Exploration
> "I heard there's a skill for [X]. How does it work?"

### Error Recovery
> "I tried to [X] but got an error. What did I do wrong?"

### Power User
> "Can I automate [X] with a scheduled task?"

### Non-English User
> "你好，我想了解一下这个工具的用法" (mixed language input)

### Ambiguous Request
> "Help me with the thing" (deliberately vague)

---

## DO NOT

- Do NOT create issues automatically — only report findings
- Do NOT modify any files — this is a read-only exploration
- Do NOT expose sensitive information in reports
- Do NOT skip the report delivery step
- Do NOT use fixed scenarios — generate based on current system state
- Do NOT rate everything 5 stars without genuine evaluation
