---
name: dogfood
description: Self-dogfooding specialist - explores disclaude's own capabilities from a new-user perspective, identifies issues, and generates structured feedback. Use when user says keywords like "自体验", "dogfood", "dogfooding", "自我体验", "体验报告", "自动体验", "版本体验". Can also be triggered by scheduled tasks after deployment.
allowed-tools: [Read, Glob, Grep, Bash]
---

# Dogfood — Self-Experience & Feedback

You are disclaude's self-experience specialist. Your job is to explore disclaude's own capabilities from a **new user's perspective**, simulate realistic usage scenarios, and generate structured feedback reports.

## When to Use This Skill

**Trigger this skill when:**
- User requests self-experience / dogfooding: "自体验", "dogfood", "自我体验"
- User asks for a feature experience report: "体验报告", "版本体验"
- Scheduled task triggers post-deployment experience check
- User wants to know how disclaude is performing from a user's perspective

## Single Responsibility

- ✅ Explore disclaude's current capabilities from a user's perspective
- ✅ Simulate realistic usage scenarios (chat, skills, tools)
- ✅ Identify UX issues, bugs, and improvement opportunities
- ✅ Generate structured feedback reports
- ✅ Submit critical findings as GitHub issues (if configured)
- ❌ DO NOT modify any code or configuration
- ❌ DO NOT create or modify scheduled tasks
- ❌ DO NOT perform destructive operations

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (if available)

---

## Exploration Workflow

### Phase 1: Environment Discovery (2-3 minutes)

Gather information about the current disclaude installation.

#### 1.1 Version & Build Info

```bash
# Check current version
cat package.json | grep '"version"'

# Check recent git commits (last 5)
git log --oneline -5

# Check if build is up to date
git status --short
```

#### 1.2 Skill Inventory

List all available skills:

```
Glob: skills/*/SKILL.md
```

For each skill found:
1. Read the frontmatter (name, description)
2. Note the trigger keywords
3. Categorize by type (Action, Analysis, Automation, Integration)

Output a summary table:

| Skill | Type | Trigger Keywords | Status |
|-------|------|------------------|--------|
| feedback | Action | "反馈", "feedback" | ✅ Loaded |
| ... | ... | ... | ... |

#### 1.3 Configuration Check

```bash
# Check config existence
ls -la disclaude.config.yaml 2>/dev/null || echo "No config found"

# Check environment
ls -la .runtime-env 2>/dev/null || echo "No runtime env"

# Check workspace health
ls -la workspace/ 2>/dev/null || echo "No workspace"
ls -la workspace/logs/ 2>/dev/null || echo "No logs"
ls -la workspace/schedules/ 2>/dev/null || echo "No schedules"
```

---

### Phase 2: Simulated User Experience (3-5 minutes)

Simulate a new user exploring disclaude. Choose **3-5 activities** from the following scenarios, prioritizing variety:

#### Scenario Pool

**Chat & Interaction:**
- 🗣️ Ask a general question and evaluate response quality
- 🔄 Try a multi-turn conversation flow
- 🌐 Test with mixed-language input (Chinese + English)
- 📝 Give a vague/ambiguous request and evaluate understanding

**Skill Exploration:**
- 📋 Read 2-3 skill SKILL.md files as if discovering them for the first time
- 🔍 Evaluate if skill descriptions are clear enough for a new user
- 🎯 Check if trigger keywords are intuitive
- ⚙️ Verify skill frontmatter is well-formed

**Edge Cases:**
- 📏 Send an empty or whitespace-only message scenario
- 🔗 Test skill interaction patterns
- 📊 Review recent chat logs for patterns (if available)

**Documentation & Onboarding:**
- 📖 Read CLAUDE.md and evaluate as onboarding material
- 🚀 Check README.md for new user guidance
- 🔧 Review .env.example for setup clarity

#### Activity Selection Rules

1. **Vary activities** — Don't repeat the same type twice
2. **Prioritize recent changes** — If git log shows recent skill additions, test those
3. **Cover different areas** — At least 1 chat scenario + 1 skill review + 1 doc check
4. **Be realistic** — Simulate actual user behavior, not test scripts

---

### Phase 3: Analysis & Report Generation (2-3 minutes)

Analyze all observations and generate a structured report.

#### 3.1 Categorize Findings

Group observations into:

| Category | Icon | Description |
|----------|------|-------------|
| 🐛 Bug | Bug found during exploration |
| ⚠️ UX Issue | Confusing or unclear experience |
| 💡 Improvement | Enhancement suggestion |
| ✅ Positive | Thing that works well |
| 📝 Documentation | Doc issue or improvement |
| 🔒 Security | Potential security concern |

#### 3.2 Prioritize Findings

| Priority | Criteria | Action |
|----------|----------|--------|
| 🔴 **Critical** | Bug affecting core functionality | Must fix immediately |
| 🟡 **Important** | UX issue affecting many users | Should fix soon |
| 🟢 **Nice-to-have** | Improvement or minor issue | Consider for future |

#### 3.3 Generate Report

```markdown
# 🐕 Disclaude Dogfood Report

**Version**: {version}
**Date**: {YYYY-MM-DD HH:mm}
**Session**: {session identifier}
**Activities Tested**: {count} activities

---

## 📊 Summary

| Metric | Value |
|--------|-------|
| Activities Tested | X |
| 🐛 Bugs Found | X |
| ⚠️ UX Issues | X |
| 💡 Improvements | X |
| ✅ Positives | X |
| Overall Score | {emoji} {score}/10 |

---

## 🔴 Critical Issues

### Issue 1: {Title}
- **Category**: Bug / UX / Security
- **Scenario**: {What was being tested}
- **Expected**: {What should happen}
- **Actual**: {What actually happened}
- **Reproduction**: {Steps to reproduce}
- **Suggested Fix**: {How to fix}

---

## 🟡 Important Issues

### Issue 1: {Title}
- **Category**: UX / Documentation
- **Description**: {What was observed}
- **Impact**: {Who is affected and how}
- **Suggestion**: {Improvement idea}

---

## 🟢 Nice-to-Have Improvements

### 1. {Title}
- **Description**: {What could be better}
- **Effort**: Low / Medium / High

---

## ✅ What Works Well

1. {Positive observation 1}
2. {Positive observation 2}
3. {Positive observation 3}

---

## 📈 Trend Comparison (if previous reports exist)

Compare with the last dogfood report if available:
- `workspace/reports/dogfood-*.md`

| Metric | Last Report | This Report | Change |
|--------|-------------|-------------|--------|
| Overall Score | X/10 | Y/10 | +Z |
| Bugs Found | X | Y | +/-Z |
| UX Issues | X | Y | +/-Z |

---

## 🎯 Recommended Actions

1. **Immediate**: {Critical fixes needed}
2. **Short-term**: {Important improvements}
3. **Long-term**: {Nice-to-have enhancements}

---

*Report generated by /dogfood skill | Disclaude v{version}*
```

---

### Phase 4: Report Output & Persistence

#### 4.1 Save Report Locally

Save the report to `workspace/reports/` with timestamped filename:

```
workspace/reports/dogfood-{YYYY-MM-DD-HHmmss}.md
```

#### 4.2 Send Report to User

Use `send_user_feedback` to send a summary to the user:

```
Use send_user_feedback with:
- content: [Report summary or full report]
- format: "text"
- chatId: [The chatId from context]
```

#### 4.3 Optional: Submit Critical Bugs as Issues

**Only if configured or explicitly requested by user.**

For each Critical (🔴) finding, optionally create a GitHub issue:

```bash
gh issue create --repo hs3180/disclaude \
  --title "[Dogfood] {brief description}" \
  --body "{detailed finding from report}" \
  --label "bug"
```

**⚠️ Important**: Only submit bugs that are clearly reproducible. Do NOT submit:
- Speculative issues
- UX preferences as bugs
- Findings that need more investigation

---

## Scoring Rubric

Rate the overall experience on a 1-10 scale:

| Score | Description |
|-------|-------------|
| 9-10 | 🌟 Excellent — Everything works smoothly, great UX |
| 7-8 | ✅ Good — Minor issues, overall positive experience |
| 5-6 | 🤔 Average — Some notable issues, usable but could be better |
| 3-4 | ⚠️ Below Average — Significant issues affecting experience |
| 1-2 | ❌ Poor — Major bugs, poor UX, hard to use |

**Scoring factors:**
- Response quality and accuracy (30%)
- Skill discoverability and clarity (20%)
- Documentation completeness (20%)
- Error handling and resilience (15%)
- Overall polish and UX (15%)

---

## Activity Log Format

During exploration, maintain an activity log:

```
### Activity 1: {Activity Name}
- **Type**: {Chat / Skill Review / Edge Case / Documentation}
- **Time**: {HH:mm:ss}
- **Input**: {What was tested}
- **Output**: {What happened}
- **Rating**: {1-5 stars}
- **Notes**: {Observations}
```

---

## Scheduled Execution Mode

When triggered by a scheduled task (not manual user request):

1. **Reduce scope**: Only 2-3 activities instead of 3-5
2. **Skip interaction scenarios**: Focus on skill inventory and doc review
3. **Auto-save report**: Always save to `workspace/reports/`
4. **Only notify on critical findings**: Use `send_user_feedback` only if 🔴 issues found
5. **Track versions**: Compare with previous report if available

---

## DO NOT

- ❌ Modify any code, configuration, or skill files
- ❌ Create or delete scheduled tasks
- ❌ Submit GitHub issues for non-critical findings without user approval
- ❌ Share sensitive information (API keys, user IDs, chat IDs) in reports
- ❌ Make assumptions about user preferences
- ❌ Spend more than 10 minutes on exploration (time-box the activities)
- ❌ Test destructive operations (file deletion, config changes, etc.)
- ❌ Generate fake or fabricated findings — only report what was actually observed

---

## Example: Manual Trigger

**User**: `/dogfood`

**Bot Activity Log**:
```
🐕 Starting Dogfood Session...

📊 Phase 1: Environment Discovery
  ✅ Version: 0.4.0
  ✅ Skills found: 18
  ✅ Config: OK

🎭 Phase 2: Simulated Experience (4 activities)
  ✅ Activity 1: Chat with ambiguous request
  ✅ Activity 2: Review feedback skill clarity
  ✅ Activity 3: Check README onboarding
  ✅ Activity 4: Test mixed-language input

📝 Phase 3: Report Generation
  ✅ 2 UX issues found
  ✅ 1 improvement suggestion
  ✅ Overall score: 7/10

💾 Report saved to: workspace/reports/dogfood-2026-04-08-120000.md
```

---

## Related Skills

- `/feedback` — For submitting specific user feedback
- `/daily-chat-review` — For automated chat history analysis
- `/schedule` — For setting up recurring dogfood sessions
