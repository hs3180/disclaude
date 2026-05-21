---
name: self-experience
description: Self-experience (dogfooding) module - automatically explores own features from a new-user perspective, simulates diverse interactions, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验".
allowed-tools: Read, Glob, Grep, Bash, WebSearch
---

# Self-Experience (Dogfooding)

Automatically explore own features from a new-user perspective, simulate diverse interactions, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Automated self-testing of all available features
- Simulating new-user experience journeys
- Discovering usability issues and edge cases
- Generating structured feedback reports for developers
- Periodic quality assurance through dogfooding

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验"

## Core Principle

**Simulate a curious new user exploring the system for the first time.**

The LLM should act as an unfamiliar user, discovering features organically rather than running scripted tests. This approach surfaces UX issues that automated tests miss.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Exploration Process

### Step 1: Discover Available Features

Catalog all available features by scanning the system:

```bash
# List all skills
ls skills/

# List all schedule configurations
ls schedules/ 2>/dev/null || echo "No schedules directory"

# Read configuration
cat disclaude.config.yaml 2>/dev/null || cat disclaude.config.example.yaml | head -50
```

For each discovered skill, read its `SKILL.md` to understand:
- What the skill does
- What keywords trigger it
- What tools it needs
- Expected user interaction patterns

### Step 2: Design Exploration Scenarios

Based on discovered features, design **diverse exploration scenarios** covering:

| Scenario Type | Description | Example |
|---------------|-------------|---------|
| **Feature Discovery** | Try each skill as a first-time user | Invoke each skill with natural language |
| **Edge Cases** | Push boundaries with unusual inputs | Empty input, very long text, mixed languages |
| **Multi-turn Conversation** | Simulate real chat sessions | Ask follow-up questions, change topics |
| **Feature Combination** | Use multiple skills together | Chain skill outputs into new requests |
| **Error Recovery** | Trigger and observe error handling | Invalid commands, missing arguments |
| **Configuration Exploration** | Check available settings | Read config files, help text |

**Scenario Template:**
```markdown
### Scenario: {name}
- **Persona**: {new_user | power_user | confused_user | non_technical_user}
- **Goal**: {what the user tries to accomplish}
- **Steps**:
  1. {step 1}
  2. {step 2}
  3. ...
- **Expected**: {what should happen}
- **Actual**: {what actually happened}
- **Rating**: {excellent | good | acceptable | poor | broken}
```

### Step 3: Execute Explorations

For each scenario, simulate the interaction:

1. **Formulate user message**: Write as a real user would (imprecise, casual, possibly confused)
2. **Observe response quality**:
   - Is the response helpful?
   - Is the tone appropriate?
   - Does it handle ambiguity well?
   - Are there unnecessary clarifying questions?
3. **Test edge cases**:
   ```
   # Example edge case inputs
   - Empty/whitespace-only messages
   - Very long messages (>4000 chars)
   - Mixed language input (中英混合)
   - Emoji-only messages
   - Repeated identical messages
   - Ambiguous requests
   - Contradictory follow-up messages
   ```
4. **Rate the experience** on a 1-5 scale for each dimension:
   - **Clarity**: Was the response easy to understand?
   - **Accuracy**: Was the information correct?
   - **Helpfulness**: Did it solve the user's intent?
   - **Speed Perception**: Did it feel responsive?
   - **Error Handling**: Were errors handled gracefully?

### Step 4: Generate Feedback Report

Create a structured report with the following sections:

```markdown
# Self-Experience Report

**Date**: {date}
**Version**: {from package.json or CHANGELOG.md}
**Duration**: {approximate time spent}
**Features Explored**: {count} skills, {count} scenarios

---

## Executive Summary

{2-3 sentence overview of the experience}

**Overall Rating**: {X.X}/5.0

---

## Feature Coverage

| Feature | Tested | Rating | Notes |
|---------|--------|--------|-------|
| {skill 1} | Yes | 4/5 | {brief note} |
| {skill 2} | Yes | 3/5 | {brief note} |
| ... | ... | ... | ... |

---

## Highlights (What Worked Well)

1. **{highlight 1}**: {description}
2. **{highlight 2}**: {description}

---

## Issues Found

### Issue 1: {title}
- **Severity**: {critical | major | minor | suggestion}
- **Category**: {bug | ux | performance | documentation}
- **Description**: {what happened}
- **Steps to Reproduce**:
  1. {step}
  2. {step}
- **Expected Behavior**: {what should happen}
- **Suggestion**: {how to fix}

---

## Improvement Suggestions

1. **{suggestion 1}**: {description and rationale}
2. **{suggestion 2}**: {description and rationale}

---

## Detailed Scenario Results

{Include all scenario templates from Step 2 with Actual/Rating filled in}

---

## Recommendations

| Priority | Action | Impact |
|----------|--------|--------|
| P0 | {critical fix} | {why urgent} |
| P1 | {important improvement} | {why important} |
| P2 | {nice-to-have} | {why beneficial} |
```

### Step 5: Deliver Report

**Report Storage**: Save the report to the workspace:
```bash
# Save report
mkdir -p workspace/self-experience
# Write report to workspace/self-experience/report-{date}.md
```

**Report Delivery**: Send a summary to the user using `send_user_feedback` or present directly in the conversation.

**Issue Submission** (optional): For critical/major issues found, consider submitting GitHub issues:
```bash
gh issue create --repo hs3180/disclaude \
  --title "[Self-Experience] {issue title}" \
  --body "{issue details}" \
  --label "bug"
```

---

## Persona Guidelines

When simulating users, adopt different personas for variety:

### New User
- Asks basic questions
- Uses imprecise language
- Doesn't know skill names
- May be confused by technical terms
- Example: "怎么用这个机器人？能做什么？"

### Power User
- Tries advanced features
- Combines multiple skills
- Pushes edge cases
- Example: "帮我把这个PDF解析后生成PPT，然后用飞书发出去"

### Non-Technical User
- Avoids technical jargon
- Expects simple, direct answers
- May be frustrated by complexity
- Example: "我要做个投票，教我怎么弄"

### Confused User
- Sends ambiguous messages
- Changes mind mid-conversation
- Asks contradictory questions
- Example: "我想...算了不对，还是帮我查一下...等等让我想想"

---

## Quality Dimensions

Rate each interaction on these dimensions:

| Dimension | 1 (Poor) | 3 (Average) | 5 (Excellent) |
|-----------|----------|-------------|---------------|
| Clarity | Confusing response | Understandable | Crystal clear |
| Accuracy | Wrong information | Mostly correct | Perfectly accurate |
| Helpfulness | Doesn't address need | Partially helps | Fully solves problem |
| Tone | Inappropriate | Acceptable | Friendly and natural |
| Error Handling | Crashes/confuses | Shows error message | Graceful with guidance |

---

## Configuration

### Schedule Configuration

To enable periodic self-experience, create a schedule file:

```markdown
---
name: "Self-Experience Dogfooding"
cron: "0 3 * * 1"  # Every Monday at 3:00 AM
enabled: true
blocking: true
chatId: "{your_chat_id}"
---

请使用 self-experience skill 进行一次完整的自我体验测试。

要求：
1. 发现并列出所有可用功能
2. 从新用户视角设计至少 5 个探索场景
3. 执行每个场景并记录结果
4. 生成结构化反馈报告
5. 将报告保存到 workspace/self-experience/
```

---

## Integration with Other Skills

- **feedback**: Use to submit discovered issues as GitHub issues
- **daily-chat-review**: Cross-reference with daily review findings
- **schedule**: Can be run on a schedule for periodic quality checks
- **skill-creator**: Use feedback to suggest new skills or improvements

---

## Checklist

- [ ] Discovered all available skills and features
- [ ] Designed at least 5 diverse exploration scenarios
- [ ] Simulated interactions from multiple user personas
- [ ] Tested edge cases (empty input, long text, mixed language)
- [ ] Rated each scenario on quality dimensions
- [ ] Generated structured feedback report
- [ ] Saved report to workspace/self-experience/
- [ ] Identified critical/major issues for follow-up

---

## DO NOT

- Run destructive operations (delete files, drop tables, etc.)
- Send messages to real users during testing
- Submit duplicate issues for known problems
- Skip edge case testing
- Rate everything as "excellent" without critical evaluation
- Ignore minor UX friction — small issues compound
