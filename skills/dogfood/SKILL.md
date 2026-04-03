---
name: dogfood
description: Automated dogfooding specialist - simulates a new user experience of disclaude's latest version by exploring features, invoking skills, and testing edge cases. Generates structured feedback reports with findings and improvement suggestions. Use when user says keywords like "自我体验", "dogfood", "自动体验", "版本体验", "功能测试", "self-experience". Triggered by scheduler for automated execution.
allowed-tools: Read, Glob, Grep, Bash, WebSearch, send_user_feedback
---

# Dogfood — Automated Self-Experience

Simulate a real user experience of disclaude's latest version, exploring features and providing structured feedback.

## When to Use This Skill

**Use this skill for:**
- Automated post-deployment self-experience
- Proactive feature exploration and validation
- UX quality assessment from a user perspective
- Edge case discovery through anthropomorphic simulation

**Keywords that trigger this skill**: "自我体验", "dogfood", "自动体验", "版本体验", "功能测试", "self-experience", "dogfooding", "feature exploration"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Think and act like a curious new user, not a test runner.**

Do NOT execute scripted test cases. Instead, explore the system organically:
- Try things a real user might try
- Ask questions a real user would ask
- Make mistakes a real user might make
- Notice things that feel confusing or delightful

---

## Experience Process

### Step 1: Discover Current Capabilities

Before exploring, understand what's available:

1. **List all available skills**:
   ```
   Glob: skills/*/SKILL.md
   ```

2. **Read the CLAUDE.md** for project context and available commands.

3. **Check recent changelog** (if exists):
   ```
   Read: CHANGELOG.md (last 100 lines)
   ```

4. **Identify recent changes**:
   ```bash
   git log --oneline -20
   ```

5. **Understand current configuration**:
   ```
   Read: disclaude.config.example.yaml
   ```

**Output**: A mental model of what the system can do and what's new.

### Step 2: Plan Exploration Activities

Based on discovered capabilities, plan **3-5 diverse activities**. Each run should feel different — rotate through categories:

| Category | Activity Examples | What It Tests |
|----------|------------------|---------------|
| **Feature Exploration** | "What skills do you have?", "Help me with X" | Discovery UX, onboarding |
| **Skill Invocation** | Invoke 2-3 different skills via description | Skill routing, context loading |
| **Edge Case Testing** | Empty input, very long input, mixed language | Input validation, error handling |
| **Multi-turn Conversation** | Follow-up questions, topic changes | Context retention, coherence |
| **Error Scenarios** | Invalid commands, impossible requests | Graceful degradation |
| **Integration Testing** | Complex multi-step requests | End-to-end flows |

**Selection Rules**:
- Never pick the same activities twice in a row
- Prioritize recently changed features
- Include at least one edge case per run
- Balance between happy path and error scenarios

### Step 3: Execute Simulated Activities

For each planned activity, simulate a user interaction:

#### Activity Format

For each activity, document:

```markdown
### Activity N: [Name]

**Type**: [Feature Exploration / Skill Invocation / Edge Case / etc.]
**Simulated Input**: [What a user would type]
**Purpose**: [What this tests]

**Execution**:
- [Step-by-step what happened]

**Observation**:
- ✅ [What worked well]
- ⚠️ [Minor issues or friction]
- ❌ [Problems or bugs found]

**User Perspective**:
- [Would a real user understand what happened?]
- [Was the response helpful and timely?]
- [Any confusing or unexpected behavior?]
```

#### Activity Guidelines

1. **Be realistic**: Simulate actual user behavior, not ideal behavior
   - Users don't read manuals first
   - Users make typos and vague requests
   - Users expect instant responses

2. **Be thorough**: Don't just test the happy path
   - Try asking ambiguous questions
   - Try interrupting a flow
   - Try requesting conflicting things

3. **Be observant**: Note everything that stands out
   - Response time
   - Error message quality
   - Helpfulness of suggestions
   - Consistency across interactions

### Step 4: Generate Feedback Report

After all activities, synthesize findings into a structured report:

```markdown
## 🐕 Disclaude 自我体验报告

**体验时间**: [Timestamp]
**版本**: [Git hash or version]
**活动数量**: [Number of activities completed]

---

### 📊 总体评分

| 维度 | 评分 (1-5) | 说明 |
|------|-----------|------|
| 功能可用性 | ⭐⭐⭐⭐ | [Description] |
| 用户体验 | ⭐⭐⭐ | [Description] |
| 错误处理 | ⭐⭐⭐⭐ | [Description] |
| 响应质量 | ⭐⭐⭐ | [Description] |
| 一致性 | ⭐⭐⭐⭐⭐ | [Description] |

---

### ✅ 亮点 (What Worked Well)

1. **[Highlight 1]**
   - [Detailed description]
   - [Why this is good]

2. **[Highlight 2]**
   - [Detailed description]

---

### ⚠️ 改进建议 (Improvement Opportunities)

1. **[Suggestion 1]** — [Priority: High/Medium/Low]
   - **问题**: [What's not ideal]
   - **建议**: [How to improve]
   - **场景**: [When this matters]

2. **[Suggestion 2]** — [Priority: High/Medium/Low]
   - **问题**: [What's not ideal]
   - **建议**: [How to improve]

---

### ❌ 发现的问题 (Issues Found)

1. **[Issue 1]** — [Severity: Critical/Major/Minor]
   - **复现步骤**: [Steps to reproduce]
   - **预期行为**: [Expected behavior]
   - **实际行为**: [Actual behavior]
   - **建议**: [Suggested fix]

---

### 🔍 活动详情

[Include summarized activity logs]

---

### 📋 建议的后续行动

1. **[Action 1]** — [Priority/Owner]
2. **[Action 2]** — [Priority/Owner]
3. **[Action 3]** — [Priority/Owner]

---

*本报告由 Disclaude 自动体验机制生成 | 体验模式: [Activity types covered]*
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

## Activity Rotation

To ensure diverse coverage across runs, track the last run's activities in `workspace/data/dogfood-last-run.json`:

```json
{
  "lastRunAt": "2026-03-24T10:00:00Z",
  "activities": ["skill-invocation", "edge-case", "multi-turn"],
  "gitHash": "abc1234"
}
```

**Rotation Rules**:
- Read this file at the start of each run
- Exclude activity types used in the last run
- If file doesn't exist, pick freely
- Update file after each run

---

## Edge Case Catalog

Use this catalog for inspiration. Pick different items each run:

| Category | Edge Cases |
|----------|-----------|
| **Input** | Empty string, 10K+ characters, emoji-only, mixed CJK/Latin, markdown in message |
| **Commands** | Unknown slash commands, partial commands, commands with extra spaces |
| **Skills** | Non-existent skill name, skill with wrong arguments, rapid skill switching |
| **Context** | Very long conversation history, topic change mid-conversation, referencing old context |
| **Format** | Requesting code, requesting tables, requesting images, requesting structured data |
| **Timing** | Multiple rapid messages, long pause between messages, simultaneous requests |

---

## Quality Criteria

A good dogfood run should:

1. **Cover at least 3 different activity categories**
2. **Test at least 1 recently changed feature**
3. **Include at least 1 edge case**
4. **Find at least 1 improvement opportunity** (even minor)
5. **Rate all 5 dimensions honestly** (don't inflate scores)
6. **Provide actionable feedback** (not vague complaints)

---

## Integration with Scheduler

This skill is designed to be triggered by a schedule (see `schedules/dogfood.md`).

**Recommended Schedule**: Daily at 10:00 AM on weekdays
**Prerequisites**: `enabled: true` in the schedule file, valid `chatId` configured

---

## Checklist

- [ ] Read all available skills and recent changes
- [ ] Planned 3-5 diverse activities
- [ ] Read last run state for rotation
- [ ] Executed all planned activities
- [ ] Documented observations for each activity
- [ ] Generated structured feedback report
- [ ] Rated all 5 dimensions
- [ ] Updated `workspace/data/dogfood-last-run.json`
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Execute scripted test cases (this is not a test runner)
- Skip the feedback report generation
- Send reports to wrong chatId
- Rate dimensions without justification
- Repeat the same activities every run
- Modify any code or configuration during exploration
- Create issues or PRs during exploration (report findings only)
