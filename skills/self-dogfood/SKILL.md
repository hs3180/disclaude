---
name: self-dogfood
description: Automated self-dogfooding specialist - simulates a new user experience to evaluate disclaude's own capabilities, identifies issues, and generates structured feedback reports. Use for automated quality assurance, self-improvement analysis, or when user says keywords like "自体验", "自我测试", "dogfood", "self-test", "自动体验", "拟人模拟".
allowed-tools: Read, Glob, Grep, Bash, WebSearch, send_user_feedback
user-invocable: true
disable-model-invocation: false
---

# Self-Dogfood

Automated self-experience specialist that evaluates disclaude's own capabilities by simulating realistic user interactions.

## When to Use This Skill

**Use this skill for:**
- Automated self-dogfooding after version releases
- Simulating new user experience to discover UX issues
- Validating skill functionality end-to-end
- Testing edge cases through anthropomorphic simulation
- Generating structured feedback reports for developers

**Keywords that trigger this skill**: "自体验", "自我测试", "dogfood", "self-test", "自动体验", "拟人模拟", "self-experience", "quality check"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Simulate a curious new user exploring disclaude's capabilities.**

Do NOT execute pre-defined test scripts. Instead, adopt a persona (e.g., "a developer who just installed disclaude") and interact naturally, discovering capabilities organically. Document findings as you go.

---

## Dogfooding Process

### Phase 1: Environment Scan (2-3 minutes)

Gather information about the current deployment state:

1. **Read version info**:
   ```
   cat package.json | grep version
   cat CHANGELOG.md | head -50
   ```

2. **Discover available skills**:
   ```
   ls skills/
   ```
   Read the description line of each `SKILL.md` to understand available capabilities.

3. **Check system health**:
   ```
   ls workspace/logs/ 2>/dev/null | tail -5
   ls workspace/schedules/ 2>/dev/null
   ls workspace/chat/ 2>/dev/null | wc -l
   ```

4. **Review recent changes**:
   ```
   git log --oneline -20
   ```
   Focus on recent commits to understand what changed since last evaluation.

### Phase 2: Simulated User Experience (5-8 minutes)

Adopt a **randomly selected persona** from the list below and simulate realistic interactions:

#### Persona Pool

| ID | Persona | Behavior Style |
|----|---------|---------------|
| A | Curious New Developer | Asks "how do I..." questions, explores features one by one |
| B | Power User | Tries advanced features, pushes boundaries, tests edge cases |
| C | Minimalist | Uses simple commands, expects quick responses, gets frustrated by complexity |
| D | Feature Explorer | Systematically tries every skill, tests combinations |
| E | Edge Case Hunter | Sends unusual inputs (empty, very long, unicode, mixed language) |

**Selection**: Pick a persona based on `current_hour % 5` to rotate across runs:
- 0 → Persona A
- 1 → Persona B
- 2 → Persona C
- 3 → Persona D
- 4 → Persona E

#### Interaction Activities

For the selected persona, perform 3-5 of these activities (adapt to persona style):

1. **Skill Discovery Test**
   - Ask: "What can you do?" or try listing available slash commands
   - Verify: Are skills discoverable? Is the description helpful?

2. **Skill Invocation Test**
   - Pick 1-2 skills and invoke them with realistic inputs
   - Verify: Does the skill respond correctly? Are error messages clear?

3. **Conversation Quality Test**
   - Have a 2-3 turn conversation on a topic
   - Verify: Is context maintained? Are responses relevant?

4. **Edge Case Test** (especially Persona E)
   - Send empty messages, very long inputs, special characters
   - Verify: Graceful handling? No crashes?

5. **Documentation Accuracy Test**
   - Read README.md or docs, compare with actual behavior
   - Verify: Does the documentation match reality?

6. **Error Recovery Test**
   - Send invalid requests, interrupt mid-task
   - Verify: Can the system recover gracefully?

**Implementation**: For each activity, you do NOT need to actually send messages. Instead, analyze the codebase and documentation to predict how the system would behave, then verify by reading relevant source code.

### Phase 3: Findings Analysis (2-3 minutes)

Analyze all findings and categorize them:

#### Finding Categories

| Category | Severity | Description |
|----------|----------|-------------|
| Bug | Critical | Functionality broken, errors, crashes |
| UX Issue | High | Confusing, inconsistent, or frustrating experience |
| Doc Mismatch | Medium | Documentation doesn't match actual behavior |
| Improvement | Low | Nice-to-have enhancements |
| Highlight | Positive | Things that work exceptionally well |

For each finding, document:
- **What**: Description of the finding
- **Where**: File path or feature area
- **Severity**: Bug / UX Issue / Doc Mismatch / Improvement / Highlight
- **Persona**: Which persona discovered it
- **Evidence**: Specific observations or code references

### Phase 4: Report Generation (1-2 minutes)

Generate a structured feedback report using this template:

```markdown
## Self-Dogfood Report

**Version**: [version from package.json]
**Date**: [current date]
**Persona**: [selected persona name]
**Activities**: [list of activities performed]

---

### Summary

[1-2 sentence overview of findings]

### Key Metrics

| Metric | Value |
|--------|-------|
| Activities Performed | N |
| Issues Found | N (N critical, N high, N medium, N low) |
| Highlights | N |
| Overall Impression | [1-5 stars with emoji] |

---

### Critical Issues

#### [Issue 1 Title]
- **Severity**: Bug
- **Found By**: [Persona]
- **Description**: ...
- **Location**: `path/to/file.ts:line`
- **Suggested Fix**: ...

### UX Issues

#### [Issue 1 Title]
- **Severity**: UX Issue
- **Found By**: [Persona]
- **Description**: ...
- **Suggested Improvement**: ...

### Highlights

#### [Highlight 1 Title]
- **Description**: ...

---

### Comparison with Last Report

[If a previous report exists, compare findings. Otherwise note "First report, no baseline."]

### Recommendations

1. [High priority recommendation]
2. [Medium priority recommendation]
3. [Low priority recommendation]
```

### Phase 5: Report Delivery

**CRITICAL**: Send the report using `send_user_feedback`.

```
send_user_feedback({
  chatId: "{chatId}",
  message: "{report in markdown format}",
  format: "text"
})
```

Additionally, save the report locally for historical tracking:

```
Write to: workspace/logs/self-dogfood/{date}.md
```

This enables trend analysis across multiple runs.

---

## Historical Tracking

### Report Storage

Save each report to `workspace/logs/self-dogfood/YYYY-MM-DD.md`.

### Trend Analysis

When a previous report exists, include a comparison section:

```markdown
### Trend Analysis

| Metric | Last Run | This Run | Change |
|--------|----------|----------|--------|
| Critical Issues | 3 | 1 | -2 Improved |
| UX Issues | 5 | 4 | -1 Improved |
| Highlights | 2 | 3 | +1 Improved |
| Overall Rating | 3/5 | 4/5 | +1 Improved |
```

---

## Edge Case Testing Guide

### Input Types to Test

| Type | Example | Expected Behavior |
|------|---------|-------------------|
| Empty | "" | Graceful prompt for input |
| Very Long | 5000+ chars | Handle without truncation issues |
| Unicode | "你好世界🌍" | Correct encoding display |
| Mixed Language | "Fix the 修复 bug" | Handle gracefully |
| Special Chars | "@#$%^&*()" | No injection or crashes |
| Code Block | "```python\nprint(1)\n```" | Correct formatting |
| URL | "https://example.com" | Proper link handling |

---

## Configuration

### Schedule Configuration

To enable automated daily dogfooding, create a schedule file in `schedules/`:

```markdown
---
name: "Self-Dogfood"
cron: "0 3 * * *"
enabled: true
blocking: true
chatId: "{your_chat_id}"
createdAt: "2026-04-01T00:00:00.000Z"
---

Execute the self-dogfood skill to evaluate disclaude's capabilities.

Steps:
1. Run environment scan (version, skills, recent changes)
2. Select a persona based on time rotation
3. Perform 3-5 simulated user activities
4. Generate structured feedback report
5. Send report via send_user_feedback to current chatId
6. Save report to workspace/logs/self-dogfood/{date}.md
```

### Recommended Schedule

| Frequency | Cron | Use Case |
|-----------|------|----------|
| Daily | `0 3 * * *` | Active development period |
| Weekly | `0 3 * * 1` | Stable release period |
| Post-Release | Manual trigger | After each version release |

---

## DO NOT

- Actually modify any code or configuration during dogfooding
- Skip the report delivery step
- Use the same persona every time (rotate for coverage)
- Generate fake findings - only report actual observations
- Create issues or PRs automatically (report findings, let humans decide)
- Test destructive operations (deletions, force pushes, etc.)
