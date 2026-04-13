---
name: dogfooding
description: Automated self-testing and dogfooding specialist - explores disclaude's own features like a new user, tests capabilities, and generates structured feedback reports. Use when user says keywords like "自我测试", "dogfooding", "体验测试", "self-test", "auto-test", "功能验证", or triggered by scheduler for periodic quality assurance.
allowed-tools: [Read, Write, Glob, Grep, Bash, send_user_feedback]
---

# Dogfooding Self-Testing Skill

Automated self-testing — experience disclaude's own features from a user's perspective, discover issues, and generate improvement reports.

## When to Use

**Use this skill for:**
- Periodic automated self-testing of disclaude capabilities
- Post-release feature verification
- Discovering UX issues through simulated user interactions
- Generating structured quality reports
- Submitting issues for problems found

**Keywords that trigger this skill**: "自我测试", "dogfooding", "体验测试", "self-test", "auto-test", "功能验证", "dog food"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

---

## Core Principle

**Simulate a curious new user exploring the system.** Instead of running preset test cases, adopt an exploratory mindset — try things, notice friction, report honestly.

---

## Workflow

### Phase 1: Environment Discovery 🔍

Understand what you're working with.

#### 1.1 Version & Release Info

```bash
# Get current version
cat package.json | grep '"version"'

# Get recent changes
head -100 CHANGELOG.md
```

Record the current version and the most recent changelog entries.

#### 1.2 Capability Inventory

```bash
# List all available skills
ls skills/

# List all scheduled tasks
ls schedules/

# Check core packages
ls packages/
```

Read each skill's `SKILL.md` frontmatter (name + description) to build a capability map:
- Use `Glob` to find all `skills/*/SKILL.md`
- Use `Read` to extract the frontmatter from each

#### 1.3 Infrastructure Check

```bash
# Verify core tools are available
which gh && echo "✅ gh CLI available" || echo "❌ gh CLI missing"
which node && echo "✅ Node.js available" || echo "❌ Node.js missing"
which git && echo "✅ Git available" || echo "❌ Git missing"

# Check workspace structure
ls workspace/ 2>/dev/null || echo "workspace/ not found"

# Check logs directory
ls workspace/logs/ 2>/dev/null || echo "No logs directory"
```

### Phase 2: Feature Testing 🧪

Test each discovered capability systematically. For each skill/feature:

#### 2.1 Skill Loading Test

For each skill found in Phase 1.2:
1. Read the full `SKILL.md` file
2. Verify the frontmatter is valid (has `name`, `description`, `allowed-tools`)
3. Check that the skill instructions are complete and actionable
4. Note any ambiguous or missing instructions

**Evaluation criteria:**
- ✅ Skill loads without errors
- ✅ Instructions are clear and actionable
- ⚠️ Skill has incomplete or ambiguous instructions
- ❌ Skill has invalid frontmatter or missing critical sections

#### 2.2 Schedule Validity Test

For each schedule found in Phase 1.2:
1. Read the schedule file
2. Verify the frontmatter has required fields (`name`, `cron`, `enabled`)
3. Check that the cron expression is valid
4. Verify the execution steps are clear

**Evaluation criteria:**
- ✅ Schedule is well-defined and actionable
- ⚠️ Schedule has minor issues (e.g., missing optional fields)
- ❌ Schedule has invalid cron or missing required fields

#### 2.3 Configuration Consistency Test

```bash
# Check config example exists and is valid YAML
cat disclaude.config.example.yaml | head -50

# Check that all referenced skills in config exist
# Check that all skills referenced in schedules exist
```

#### 2.4 Code Quality Spot-Check

Pick 2-3 core source files at random and review:
- Are TypeScript types well-defined?
- Is error handling present?
- Are there obvious bugs or anti-patterns?
- Is the code well-organized?

Use `Grep` to check for common issues:
```bash
# Check for TODO/FIXME comments (potential known issues)
grep -r "TODO\|FIXME\|HACK\|XXX" packages/ --include="*.ts" -c

# Check for any console.log left in production code
grep -r "console\.log" packages/ --include="*.ts" -c
```

#### 2.5 Documentation Quality Test

Check key documentation files:
1. `README.md` — Is it up to date? Does it match current features?
2. `CLAUDE.md` — Is the architecture description accurate?
3. `CONTRIBUTING.md` — Are contribution guidelines clear?

### Phase 3: Exploratory Testing 🎭

Simulate unscripted user scenarios. Pick 3-5 scenarios from the list below based on what capabilities are available:

#### Scenario Templates

1. **"New user trying to get help"**
   - Look for help/documentation
   - Try to understand what the system can do
   - Note any confusing or missing onboarding info

2. **"User trying to use a skill"**
   - Pick a skill at random
   - Try to understand when/how to invoke it
   - Follow the skill's instructions mentally — do they make sense?

3. **"User encountering an error"**
   - Check how errors are handled in the codebase
   - Look for user-facing error messages
   - Are errors helpful and actionable?

4. **"User trying to configure the system"**
   - Read the config example
   - Try to understand what each config option does
   - Is it clear which options are required vs optional?

5. **"User checking system status"**
   - Look for health check mechanisms
   - Check if logs are accessible and useful
   - Is there monitoring or alerting?

6. **"Power user exploring advanced features"**
   - Check MCP tools available
   - Look at the skill creation workflow
   - Is the system extensible?

For each scenario, record:
- What you tried
- What you expected
- What actually happened (or what you observed in the code/docs)
- Pain points or confusion
- Improvement suggestions

### Phase 4: Report Generation 📊

Compile findings into a structured report.

#### 4.1 Create Report

Write the report to `workspace/data/dogfooding-reports/{date}.md`:

```markdown
# 🐕 Dogfooding Test Report

**Date**: {date}
**Version**: {version}
**Tester**: disclaude (automated)
**Duration**: ~{estimated} minutes

---

## Executive Summary

{2-3 sentence summary of overall system health}

## Test Results

| Category | Tested | Passed | Issues | Score |
|----------|--------|--------|--------|-------|
| Skills | {n} | {n} | {n} | {score}/10 |
| Schedules | {n} | {n} | {n} | {score}/10 |
| Configuration | {n} | {n} | {n} | {score}/10 |
| Documentation | {n} | {n} | {n} | {score}/10 |
| Code Quality | {n} | {n} | {n} | {score}/10 |

---

## Skills Assessment

### ✅ Well-Designed Skills
{List skills with clear, actionable instructions}

### ⚠️ Skills Needing Improvement
{List skills with issues, include specific problems}

### ❌ Broken or Incomplete Skills
{List skills with critical problems}

---

## Exploratory Findings

### 🟢 What Works Well
{Positive findings from exploratory testing}

### 🟡 Friction Points
{Minor issues that don't break functionality but hurt UX}

### 🔁 Improvement Opportunities
{Suggestions for improvement, prioritized by impact}

---

## Detailed Findings

{For each issue found, include:}
### Issue: {title}
- **Severity**: 🔴 Critical / 🟡 Warning / 🟢 Info
- **Category**: {skill/schedule/docs/code/config}
- **Description**: {what's wrong}
- **Suggestion**: {how to fix}
- **Reproducibility**: {always/sometimes/unknown}

---

## Metrics

- **Total capabilities tested**: {n}
- **Issues found**: {n}
- **Critical issues**: {n}
- **Overall health score**: {score}/10

---

*Report generated by disclaude dogfooding skill v1.0*
```

#### 4.2 Save Report

Use `Write` tool to save the report:
- Path: `workspace/data/dogfooding-reports/{YYYY-MM-DD}.md`
- Create the directory if it doesn't exist

#### 4.3 Send Report Summary

**CRITICAL**: Always send a summary report to the user using `send_user_feedback`.

Send a concise summary (not the full report) via `send_user_feedback`:

```markdown
## 🐕 Dogfooding Test Report — v{version}

**Date**: {date} | **Score**: {score}/10 | **Issues**: {count}

### Summary
{2-3 sentence overview}

### Issues Found
{Bullet list of issues by severity}

### Top Recommendations
1. {Most impactful suggestion}
2. {Second most impactful}
3. {Third most impactful}

📊 Full report saved to `workspace/data/dogfooding-reports/{date}.md`
```

### Phase 5: Issue Submission (Optional) 📋

If any **critical** issues were found during testing:

1. For each critical issue, use the `feedback` skill pattern to submit a GitHub issue:
   ```bash
   gh issue create --repo hs3180/disclaude \
     --title "[dogfooding] {issue title}" \
     --body "{sanitized issue description}" \
     --label "bug"
   ```

2. Include the `dogfooding` label context in the issue body so maintainers know it was auto-discovered.

3. Reference this issue (#1560) in submitted issues: `Discovered by: dogfooding skill (#1560)`

**Important**: Only submit issues for genuinely new, critical problems. Do NOT create duplicate issues.

---

## Test Execution Guidelines

### Scoring

| Score | Meaning |
|-------|---------|
| 9-10 | Excellent, production-ready |
| 7-8 | Good, minor improvements needed |
| 5-6 | Acceptable, several issues found |
| 3-4 | Needs attention, significant issues |
| 1-2 | Poor, critical problems found |
| 0 | Broken, unusable |

### What NOT to Do

- ❌ Do NOT modify any source code (this is read-only testing)
- ❌ Do NOT create or modify schedules or skills
- ❌ Do NOT send messages to real users
- ❌ Do NOT access or expose sensitive data (tokens, keys, user IDs)
- ❌ Do NOT run destructive commands (delete, reset, etc.)
- ❌ Do NOT submit more than 3 issues per test run
- ❌ Do NOT create issues for known/already-reported problems

### Quality Checklist

Before finalizing the report:
- [ ] All skills in `skills/` directory were examined
- [ ] All schedules in `schedules/` directory were examined
- [ ] At least 3 exploratory scenarios were tested
- [ ] Report is saved to `workspace/data/dogfooding-reports/`
- [ ] Summary is sent via `send_user_feedback`
- [ ] Critical issues are submitted as GitHub issues (if any)

---

## Example Output

### Summary Card (sent to chat):

> ## 🐕 Dogfooding Report — v0.4.0
>
> **Score**: 7/10 | **Issues**: 3 | **Date**: 2026-04-14
>
> System is generally healthy. Found 1 skill with incomplete instructions and 2 documentation gaps. Core functionality works as expected.
>
> 🔴 **Critical**: Skill `deep-task` missing required `allowed-tools` in frontmatter
> 🟡 **Warning**: README.md references v0.3.0 but package.json is v0.4.0
> 🟡 **Warning**: No error handling guide in CONTRIBUTING.md
>
> 📊 Full report: `workspace/data/dogfooding-reports/2026-04-14.md`

---

## Integration Notes

### For Schedule Integration

This skill can be triggered periodically via a schedule (see `schedules/dogfooding.md`). The recommended frequency is:
- **Weekly**: For stable releases
- **Daily**: During active development
- **On-demand**: After major changes

### For Version Trigger

To trigger on version changes, combine with the `recommend-analysis` pattern:
1. Store the last-tested version in `workspace/data/dogfooding-reports/last-version.txt`
2. On each run, compare current version with last-tested
3. If different, run full testing; if same, run quick spot-check only
