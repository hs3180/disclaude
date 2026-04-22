---
name: self-experience
description: Self-experience (dogfooding) skill - automatically tests disclaude capabilities by simulating real user activities. Generates structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "自测", "功能体验", "体验报告", "self-experience", "self-test". Can be triggered by scheduler for automated post-deployment verification.
allowed-tools: Read, Glob, Grep, Bash, WebSearch
---

# Self-Experience (Dogfooding) Skill

Automatically test disclaude's own capabilities by simulating real user activities, then generate a structured feedback report.

## When to Use This Skill

**Use this skill for:**
- Automated post-deployment verification
- Self-experience (dogfooding) sessions
- Testing feature completeness after updates
- Generating capability audit reports

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自测", "功能体验", "体验报告", "self-experience", "self-test", "体验最新版本"

## Core Principle

**Use LLM-based exploration, NOT scripted test cases.**

The agent should autonomously decide what to test based on current capabilities, simulating a real user's natural exploration behavior. This is NOT a unit test — it's a UX-level experience audit.

---

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Self-Experience Process

### Step 1: Environment Assessment

Before testing, assess the current environment:

1. **Check current version**:
   ```bash
   node -e "const p = require('./package.json'); console.log(p.name + '@' + p.version)"
   ```

2. **List available skills** to understand current capabilities:
   ```bash
   ls skills/
   ```

3. **List available schedules** to understand automation scope:
   ```bash
   ls schedules/
   ```

4. **Check recent changes** (if in a git repo):
   ```bash
   git log --oneline -10
   ```

### Step 2: Select Exploration Strategy

Based on the environment assessment, choose an exploration persona:

| Persona | When to Use | Focus |
|---------|-------------|-------|
| **New User Explorer** | First-time experience | Basic features, onboarding, ease of use |
| **Power User Tester** | Deep feature testing | Skill combinations, edge cases, advanced workflows |
| **Random Walker** | No specific focus | Random feature exploration, discovering unexpected behaviors |
| **Focused Auditor** | Post-deployment verification | Recently changed features, regression testing |

**Selection logic**:
- If invoked manually with no argument → Use **Random Walker**
- If invoked after a deployment → Use **Focused Auditor** (check recent git log)
- If first run ever → Use **New User Explorer**

### Step 3: Execute Exploration Activities

Perform 3-5 activities based on the chosen persona. Each activity should be **real** — actually execute commands, read files, or invoke skills — not just describe what you would do.

#### Activity Types

**A. Skill Readiness Check**
- Pick a random skill from `skills/`
- Read its `SKILL.md`
- Verify it has proper frontmatter (name, description, allowed-tools)
- Check if the skill's allowed-tools match what it actually needs
- Rate: ✅ Ready / ⚠️ Needs attention / ❌ Broken

**B. Code Quality Spot Check**
- Pick a random source file from `src/` or `packages/`
- Read the file
- Check for: proper error handling, TypeScript types, JSDoc comments, code complexity
- Rate: ✅ Good / ⚠️ Acceptable / ❌ Concerning

**C. Configuration Validation**
- Read `disclaude.config.example.yaml`
- Check if all referenced modules exist
- Verify configuration schema completeness
- Rate: ✅ Complete / ⚠️ Missing options / ❌ Outdated

**D. Schedule Health Check**
- Read a random schedule from `schedules/`
- Verify its referenced skill exists
- Check if the schedule's instructions are clear and actionable
- Rate: ✅ Healthy / ⚠️ Needs update / ❌ Orphaned

**E. Documentation Freshness**
- Read `CLAUDE.md` or `README.md`
- Check if the architecture description matches actual code structure
- Verify command examples still work
- Rate: ✅ Current / ⚠️ Slightly outdated / ❌ Stale

**F. Integration Smoke Test**
- Run `npm run type-check` to verify type safety
- Run `npm run lint` to check code quality
- Note any warnings or errors
- Rate: ✅ Clean / ⚠️ Minor issues / ❌ Failures

**G. Dependency Health**
- Read `package.json`
- Check for outdated or vulnerable dependencies (use WebSearch if needed)
- Look for unnecessary dependencies
- Rate: ✅ Healthy / ⚠️ Review needed / ❌ Action required

### Step 4: Generate Experience Report

Compile all findings into a structured report:

```markdown
## 🐕 Disclaude Self-Experience Report

**Version**: [version]
**Date**: [ISO timestamp]
**Persona**: [chosen persona]
**Activities Completed**: [count]

---

### 📊 Overall Health: [Score/100]

---

### ✅ Highlights

- [List of things working well]

---

### ⚠️ Issues Found

#### Issue 1: [Title]
- **Category**: [Skill | Code | Config | Docs | Schedule | Dependency]
- **Severity**: 🔴 High | 🟡 Medium | 🟢 Low
- **Description**: [What was found]
- **Location**: [File path or component]
- **Suggestion**: [Recommended fix]

---

### 📈 Activity Log

| # | Activity | Result | Time |
|---|----------|--------|------|
| 1 | [Activity name] | ✅/⚠️/❌ | [duration] |

---

### 💡 Recommendations

1. **Immediate**: [High-priority actions]
2. **Short-term**: [Medium-priority improvements]
3. **Long-term**: [Nice-to-have enhancements]

---

*Report generated by self-experience skill | Powered by Claude Code*
```

### Step 5: Deliver Report

**If invoked manually** (user present):
- Output the report directly in the conversation

**If invoked by scheduler** (automated):
- Save report to `workspace/.disclaude/self-experience/` with timestamp filename:
  ```
  workspace/.disclaude/self-experience/2026-04-22T10-00-00Z.md
  ```
- Use `send_user_feedback` to notify the main chat if available

---

## Execution Guidelines

### Do's

- ✅ Actually execute commands and read files (don't pretend)
- ✅ Be genuinely curious — explore like a real user would
- ✅ Report honestly, including positive findings
- ✅ Focus on user-perceivable issues, not internal implementation details
- ✅ Keep each activity under 2 minutes (5-10 activities max per session)
- ✅ Randomize selection to avoid testing the same things every time

### Don'ts

- ❌ Don't write or modify any files (read-only exploration)
- ❌ Don't submit issues automatically (report only, let user decide)
- ❌ Don't test destructive operations (delete, remove, reset)
- ❌ Don't run full test suites (that's CI's job)
- ❌ Don't spend more than 15 minutes on a single session
- ❌ Don't test the same skill/activity twice in one session

---

## Schedule Integration

To enable automated self-experience, create a schedule file in `schedules/`:

```markdown
---
name: "Self-Experience"
cron: "0 10 * * 1"
enabled: true
blocking: true
chatId: "{your_chat_id}"
---

Execute a self-experience session using the self-experience skill.

Use the "Focused Auditor" persona. Check recent git changes and focus verification on recently modified areas. Save the report to workspace/.disclaude/self-experience/ and send a summary to this chat.
```

**Recommended schedule**: Once per week (e.g., Monday 10:00) or after deployments.

---

## Example Session

### Input
```
/self-experience
```

### Agent Actions
1. Checks version: `disclaude@0.5.0`
2. Lists 20+ skills, picks `feedback` skill for readiness check
3. Reads `skills/feedback/SKILL.md` — verifies frontmatter ✅
4. Picks `packages/core/src/config/index.ts` for code quality check
5. Reads file — notices missing error handling in one function ⚠️
6. Runs `npm run type-check` — passes ✅
7. Checks `CLAUDE.md` architecture — matches code ✅

### Output Report (excerpt)
```markdown
## 🐕 Disclaude Self-Experience Report
**Version**: disclaude@0.5.0
**Persona**: Random Walker
**Activities Completed**: 4

### 📊 Overall Health: 85/100

### ⚠️ Issues Found
#### Issue 1: Missing error handling in config validation
- **Category**: Code
- **Severity**: 🟡 Medium
- **Location**: packages/core/src/config/index.ts
```

---

## Checklist

- [ ] Assessed current environment (version, skills, schedules)
- [ ] Selected appropriate exploration persona
- [ ] Completed 3-5 exploration activities
- [ ] Each activity produced a genuine result (not simulated)
- [ ] Generated structured report with ratings
- [ ] Delivered report to user or saved to workspace
