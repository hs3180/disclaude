---
name: self-experience
description: Self-experience (dogfooding) module - automatically explores own features from a new-user perspective, simulates diverse interactions, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验".
allowed-tools: Read, Glob, Grep, Bash, WebSearch
---

# Self-Experience (Dogfooding)

Automatically explore own features from a new-user perspective, simulate diverse interactions, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Proactively testing own features after a new release or deployment
- Simulating new-user exploration of available capabilities
- Generating structured quality feedback reports
- Discovering UX issues, missing documentation, or broken workflows

**DO NOT use this skill for:**
- Unit testing or CI/CD testing -> Use existing test infrastructure
- Security auditing -> Use dedicated security tools
- Performance benchmarking -> Use dedicated benchmark tools

**Keywords**: "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验", "自我检查"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Simulate a curious new user exploring the platform for the first time.** Do not assume knowledge of internal architecture. Evaluate everything from the perspective of discoverability, usability, and completeness.

---

## Experience Process

### Step 1: Discover Available Features

Scan the environment to understand what capabilities are available:

1. **List all skills**: Read all `SKILL.md` files in `skills/` directory
   ```
   Glob: skills/*/SKILL.md
   ```

2. **Check available slash commands**: Extract skill names from frontmatter

3. **Review recent changes**: Check git log for recent changes
   ```bash
   git log --oneline -20
   ```

4. **Check scheduled tasks**: Look at `schedules/` directory for active scheduled tasks
   ```
   Glob: schedules/*/SCHEDULE.md
   ```

5. **Review project configuration**: Read `disclaude.config.example.yaml` to understand available settings

**Output**: A structured inventory of all available features and capabilities.

### Step 2: Design Exploration Scenarios

Based on the discovered features, design **5-8 diverse exploration scenarios** from a new-user perspective. Each scenario should test a different aspect:

| Scenario Category | Purpose | Example |
|---|---|---|
| **Basic Interaction** | Can a new user start using the bot easily? | Send a greeting, ask a question |
| **Skill Invocation** | Are skills discoverable and easy to use? | Try `/feedback`, `/daily-chat-review` |
| **Edge Cases** | How does the bot handle unexpected input? | Empty message, very long input, mixed languages |
| **Workflow Integration** | Do skills work together smoothly? | Schedule a task, then review results |
| **Error Recovery** | What happens when things go wrong? | Invalid commands, missing arguments |
| **Documentation Quality** | Is help available and useful? | Ask "what can you do?" |
| **Feature Completeness** | Do features work as advertised? | Test a specific skill end-to-end |
| **Multi-turn Conversation** | Does context persist across messages? | Reference earlier conversation |

**For each scenario, define:**
- **Scenario name**: Short descriptive title
- **User intent**: What a real user would want to accomplish
- **Test actions**: Specific steps to simulate
- **Expected outcome**: What should happen
- **Priority**: High / Medium / Low

### Step 3: Execute Exploration

For each scenario, simulate the interaction and evaluate:

1. **Act as a new user**: No assumptions about internal knowledge
2. **Follow the scenario steps**: Execute each action as designed
3. **Record observations**: Note what works, what's confusing, what's broken
4. **Rate the experience**: Use a simple scale

**Rating Scale:**

| Rating | Meaning | Criteria |
|--------|---------|----------|
| Excellent | Works perfectly | Intuitive, fast, correct output |
| Good | Works with minor issues | Mostly intuitive, minor friction |
| Needs Improvement | Functional but confusing | Works but hard to discover/use |
| Broken | Does not work as expected | Error, wrong output, or no response |

### Step 4: Generate Feedback Report

Create a structured feedback report using the following format:

```markdown
# Self-Experience Report

**Date**: [Current date]
**Version**: [From git log or package.json]
**Duration**: [Estimated time spent]
**Scenarios Tested**: [Number]

---

## Executive Summary

[2-3 sentence overview of the experience quality]

**Overall Score**: X/10

---

## Feature Inventory

| Category | Features Found | Status |
|----------|---------------|--------|
| Skills | X skills available | Brief assessment |
| Scheduled Tasks | X schedules active | Brief assessment |
| Configuration | X config options | Brief assessment |

---

## Scenario Results

### Scenario 1: [Name]
- **Category**: [Basic/Edge/Integration/etc.]
- **Rating**: [Excellent/Good/Needs Improvement/Broken]
- **Observations**: [What happened]
- **Issues Found**: [List any issues]

[Repeat for each scenario]

---

## Issues Discovered

### Critical Issues
- [Issues that block basic usage]

### UX Issues
- [Issues that make features hard to discover or use]

### Documentation Gaps
- [Missing or unclear documentation]

### Suggestions
- [Ideas for improvement]

---

## Highlights
- [Things that worked well, delightful experiences]

---

## Recommended Actions

1. **Immediate** (fix now): [Critical issues]
2. **Short-term** (next sprint): [UX improvements]
3. **Long-term** (backlog): [Feature enhancements]
```

### Step 5: Deliver Report

**Send the report to the user using `send_user_feedback`** (or equivalent MCP tool).

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

If `send_user_feedback` is not available, output the report directly in the conversation.

---

## Scenario Design Guidelines

### Good Scenarios
- Based on real user personas (new user, power user, casual user)
- Test end-to-end workflows, not isolated functions
- Include edge cases that real users might encounter
- Cover both success and failure paths

### Bad Scenarios
- Testing internal implementation details
- Scenarios that require system-level access
- Scenarios that modify production data
- Scenarios that require external dependencies

---

## Integration with Other Skills

- **/feedback**: If critical issues are found, suggest submitting via `/feedback`
- **/daily-chat-review**: Complementary — daily review analyzes real user interactions, self-experience simulates them
- **/schedule-recommend**: If self-experience runs regularly, its patterns can inform schedule recommendations

---

## Checklist

- [ ] Discovered all available features (skills, schedules, config)
- [ ] Designed 5-8 diverse exploration scenarios
- [ ] Executed each scenario from a new-user perspective
- [ ] Rated each scenario with specific observations
- [ ] Generated structured feedback report
- [ ] **Sent report to user** (CRITICAL)

---

## DO NOT

- Modify any production data or configuration during exploration
- Create real GitHub issues or pull requests during testing
- Send messages to real users or external chat groups during testing
- Execute destructive commands (delete, reset, force-push)
- Skip the report delivery step
- Rate scenarios based on internal implementation quality rather than user experience
- Assume knowledge that a new user would not have
