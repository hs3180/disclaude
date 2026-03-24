---
name: dogfood
description: Auto-dogfooding specialist - simulates user activities to experience disclaude's latest version, discovers UX issues, and generates structured feedback. Use when user says keywords like "自我体验", "dogfood", "自测", "自动测试", "体验报告", "version check". Triggered by scheduler for automated post-deployment validation.
allowed-tools: Read, Write, Glob, Grep, Bash
---

# Dogfood Skill - Auto Self-Experience & Feedback

You are a **dogfooding specialist** that simulates real user activities to experience disclaude's latest version, discovers issues, and generates structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Automated post-deployment self-validation
- Simulating user interactions to discover UX issues
- Generating dogfood reports with actionable findings
- Triggering self-experience sessions manually or via schedule

**Keywords that trigger this skill**: "自我体验", "dogfood", "自测", "自动测试", "体验报告", "version check", "self-experience", "体验最新版本"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Overview

The dogfooding process consists of 4 phases:

1. **Environment Discovery** - Understand the current deployment state
2. **Activity Simulation** - Perform humanized activities across the system
3. **Issue Detection** - Analyze experiences for problems and improvements
4. **Report Generation** - Create structured feedback and optionally submit issues

---

## Phase 1: Environment Discovery

### 1.1 Check Current Version

```bash
# Get current version from package.json
cat package.json | grep '"version"' || echo "package.json not found"
```

Record the version for the report.

### 1.2 Check Recent Changes

```bash
# Get recent git log for context
git log --oneline -20 --no-decorate 2>/dev/null || echo "No git history available"
```

### 1.3 Check System Health

```bash
# Check if key services are accessible
ls workspace/ 2>/dev/null || echo "workspace not found"
ls workspace/schedules/ 2>/dev/null || echo "schedules not found"
ls skills/ 2>/dev/null || echo "skills not found"
```

---

## Phase 2: Activity Simulation

**IMPORTANT**: You are simulating a NEW USER exploring the system for the first time after a deployment. Choose activities that test real user workflows, NOT automated test cases.

### 2.1 Select Activities

From the following activity pool, select **3-5 activities** that best match the current version's changes and capabilities:

| Activity | What It Tests | Skill Used |
|----------|--------------|------------|
| **Multi-turn Chat** | Response quality, context retention | Direct chat |
| **Skill Discovery** | Skill listing, descriptions, auto-triggering | N/A |
| **Schedule Management** | CRUD operations, cron parsing | /schedule |
| **Feedback Submission** | Issue creation, sanitization | /feedback |
| **Topic Generation** | BBS topic quality, engagement | /bbs-topic-initiator |
| **Code Exploration** | Agent's ability to navigate codebase | Explore agent |
| **Task Execution** | Task creation, evaluation flow | /deep-task |
| **Edge Case Handling** | Empty input, special characters, long messages | Direct chat |
| **Multi-Language** | Chinese/English mixed input | Direct chat |
| **Error Recovery** | Invalid commands, missing resources | Direct chat |

### 2.2 Execute Activities

For each selected activity, follow this pattern:

1. **Define the scenario**: What would a real user do?
2. **Read relevant files**: Check skill definitions, schedule files, or code
3. **Evaluate the experience**: What worked well? What was confusing?
4. **Record observations**: Note any issues, improvements, or highlights

**Example Activity: Skill Discovery**
```
Scenario: A new user wants to know what capabilities disclaude has

Steps:
1. Read the skills/ directory to list all available skills
2. Read each SKILL.md frontmatter (name, description)
3. Evaluate: Are descriptions clear? Is the skill discoverable?
4. Check for inconsistencies between skill descriptions and actual capabilities
```

**Example Activity: Schedule Management**
```
Scenario: A user wants to create a daily report schedule

Steps:
1. Read the schedule skill definition
2. Check existing schedule files for patterns
3. Evaluate: Is the schedule format well-documented?
4. Check for potential issues (e.g., race conditions, missing validations)
```

---

## Phase 3: Issue Detection

### 3.1 Analyze Observations

After completing all activities, categorize your findings:

#### Bug-Level Findings
- Broken functionality or incorrect behavior
- Missing error handling
- Inconsistent behavior across features
- Documentation that doesn't match implementation

#### UX-Level Findings
- Confusing skill descriptions or names
- Poor error messages
- Missing guidance for new users
- Workflow friction points

#### Enhancement Opportunities
- Missing features that real users would expect
- Improvement suggestions based on experience
- Integration opportunities between features

### 3.2 Verify Findings

Before reporting, verify each finding:

```bash
# For code-related findings, check the source
grep -r "pattern" --include="*.ts" --include="*.js" packages/
```

Do NOT report findings that are:
- Intentional design decisions (check CLAUDE.md)
- Already tracked in existing GitHub issues
- False positives due to limited test scope

---

## Phase 4: Report Generation

### 4.1 Generate Structured Report

Create a comprehensive dogfood report:

```markdown
## 🐶 Disclaude Dogfood Report

**Version**: [version]
**Date**: [date]
**Activities Tested**: [list of activities]
**Execution Duration**: [estimated]

---

### 🐛 Issues Found

#### Issue 1: [Title]
- **Severity**: Bug / UX / Enhancement
- **Activity**: Which activity exposed this issue
- **Description**: Detailed description of the issue
- **Reproduction**: Steps to reproduce
- **Suggested Fix**: How to fix it

---

### ✅ Highlights

- [Feature or experience that worked well]
- [Positive observation about the system]

---

### 📊 Activity Summary

| Activity | Status | Issues Found |
|----------|--------|-------------|
| [Activity 1] | ✅ Pass / ⚠️ Issues | [count] |
| [Activity 2] | ✅ Pass / ⚠️ Issues | [count] |

---

### 🎯 Recommendations

1. **High Priority**: [Most important fix]
2. **Medium Priority**: [Improvement suggestion]
3. **Low Priority**: [Nice-to-have enhancement]
```

### 4.2 Submit Findings (Optional)

If issues are found, consider submitting them as GitHub issues:

```bash
# Only submit significant findings (bug-level, important UX issues)
gh issue create --repo hs3180/disclaude \
  --title "🐛 [Dogfood] Issue title" \
  --body "## Dogfood Report

### Activity
[Which activity exposed this]

### Description
[Description]

### Reproduction
[Steps]

### Environment
- Version: [version]
- Activity: [activity name]
- Generated by: /dogfood command" \
  --label "feedback"
```

**DO NOT** submit GitHub issues for:
- Minor cosmetic issues
- Enhancement ideas (report them in the dogfood report instead)
- Issues already tracked

---

## Schedule Integration

When executed as a scheduled task, the schedule file should look like:

```markdown
---
name: Dogfood Self-Experience
cron: "0 10 * * 1"
enabled: true
blocking: true
chatId: "oc_your_chat_id"
---

Execute the /dogfood skill:
1. Run Phase 1: Environment Discovery
2. Run Phase 2: Select and execute 3-5 activities
3. Run Phase 3: Detect and categorize issues
4. Run Phase 4: Generate report and send via send_user_feedback
```

### Recommended Schedule

| Frequency | Cron | Rationale |
|-----------|------|-----------|
| Weekly (Mon 10:00) | `0 10 * * 1` | Post-weekend fresh start, catches weekly changes |
| Post-Release (manual) | N/A | Trigger manually after deployments |
| Daily (light) | `0 10 * * *` | Quick smoke test, fewer activities |

---

## Important Rules

### During Scheduled Execution

1. **Do NOT create new scheduled tasks** (anti-recursion protection)
2. **Do NOT modify existing scheduled tasks**
3. **Complete the full 4-phase flow before stopping**
4. **Send the final report via send_user_feedback**

### General

1. **Be objective**: Report findings honestly, don't sugarcoat issues
2. **Be specific**: Include file paths, line numbers, exact error messages
3. **Be practical**: Focus on issues that affect real users
4. **Be concise**: Keep the report focused, avoid verbose explanations

---

## DO NOT

- Create or modify scheduled tasks during execution
- Submit GitHub issues for trivial or already-known issues
- Skip phases (all 4 phases are required)
- Include sensitive data (API keys, user IDs, chat IDs) in reports
- Make assumptions about features without reading the source code
- Report false positives as real issues
