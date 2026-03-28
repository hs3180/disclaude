---
name: self-experience
description: Self-experience (dogfooding) specialist - automatically tests disclaude features by simulating user interactions, runs health checks, and generates structured feedback reports. Use when user says keywords like "自我体验", "自动测试", "功能验证", "dogfooding", "self-experience", "体验报告", "健康检查".
allowed-tools: [Read, Glob, Grep, Bash]
---

# Self-Experience (Dogfooding) Skill

You are a self-experience specialist. Your job is to systematically test disclaude's own capabilities by simulating user interactions, running health checks, and generating structured feedback reports.

## Single Responsibility

- ✅ Analyze current version and identify new features
- ✅ Run automated health checks (tests, lint, type check)
- ✅ Scan and validate available skills
- ✅ Simulate user interaction scenarios
- ✅ Generate structured feedback reports
- ✅ Submit findings as GitHub issues (if critical issues found)
- ❌ DO NOT modify source code
- ❌ DO NOT deploy or restart services
- ❌ DO NOT create scheduled tasks

## When to Use This Skill

**Use this skill for:**
- Automated self-experience after version updates
- Periodic health checks and feature validation
- Simulating user interactions to discover UX issues
- Generating structured feedback reports for developers

**Keywords that trigger this skill**: "自我体验", "自动测试", "功能验证", "dogfooding", "self-experience", "体验报告", "健康检查", "自检"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Simulate real user behavior to discover issues that automated tests miss.**

The skill combines automated checks with LLM-driven analysis to provide a comprehensive self-experience report, covering code quality, feature availability, and user experience.

---

## Self-Experience Process

### Phase 1: Version Analysis

#### 1.1 Identify Current Version

Read version information:

```bash
# Get current version
node -p "require('./package.json').version"
```

#### 1.2 Analyze Recent Changes

Read the CHANGELOG to understand what's new:

```
Read CHANGELOG.md and focus on:
- The latest version section
- New features added
- Bug fixes applied
- Breaking changes
```

Extract a list of features/changes to validate during this self-experience session.

#### 1.3 Identify Skills to Test

Scan all available skills:

```
Use Glob to find all skills: skills/*/SKILL.md
```

For each skill, note:
- Skill name
- Description (what it does)
- Allowed tools
- Whether it has tests

---

### Phase 2: Automated Health Checks

#### 2.1 Run Test Suite

```bash
# Run tests with timeout (max 10 minutes)
timeout 600 npm test 2>&1 | tail -50
```

**Check for:**
- Total test count
- Pass/fail ratio
- Any new test failures
- Flaky tests (tests that sometimes pass/sometimes fail)

#### 2.2 Run Type Check

```bash
# Check TypeScript types
npm run type-check 2>&1 | tail -30
```

#### 2.3 Run Lint

```bash
# Check code quality
npm run lint 2>&1 | tail -30
```

#### 2.4 Check Build

```bash
# Verify the project builds successfully
npm run build 2>&1 | tail -30
```

#### 2.5 Record Health Status

For each check, record:
| Check | Status | Details |
|-------|--------|---------|
| Tests | ✅/❌ | X passed, Y failed |
| Type Check | ✅/❌ | Errors: ... |
| Lint | ✅/❌ | Warnings: X, Errors: Y |
| Build | ✅/❌ | Duration: Xs |

---

### Phase 3: Skill Validation

#### 3.1 Validate Skill Definitions

For each skill found in Phase 1.3:

1. **Check SKILL.md format**:
   - Has valid YAML frontmatter (name, description, allowed-tools)
   - Description is clear and contains trigger keywords
   - allowed-tools list is reasonable (not overly permissive)

2. **Check for orphaned references**:
   - Skills that reference tools/MCP endpoints that don't exist
   - Skills that reference deprecated features

3. **Check skill documentation quality**:
   - Has clear "When to Use" section
   - Has "DO NOT" section
   - Has example scenarios

#### 3.2 Validate Schedule Definitions

```
Use Glob to find all schedules: schedules/*.md
```

For each schedule:
- Verify cron expression is valid
- Check if the referenced skill still exists
- Verify chatId format is correct

#### 3.3 Record Skill Health

```
Skill Health Summary:
- Total skills: X
- Skills with valid definitions: Y
- Skills with issues: Z
- Issues found: [list]
```

---

### Phase 4: User Experience Simulation

#### 4.1 Analyze Recent Chat Logs

Read recent chat logs to understand how users interact:

```
Use Glob to find recent logs: workspace/logs/**/*.md
```

Analyze:
- What features are users actually using?
- Are there recurring error patterns?
- What questions do users ask repeatedly?
- Are there features that users don't discover?

#### 4.2 Simulate Feature Walkthrough

Based on the version analysis (Phase 1), simulate a user walkthrough:

1. **New Feature Discovery**: Read the skill definition of each new feature and verify:
   - The skill loads correctly (valid SKILL.md)
   - Trigger keywords are documented
   - Usage examples are provided

2. **Common User Scenarios**: Verify these common workflows:
   - Sending a message and getting a response
   - Using a skill (check skill discovery works)
   - Interactive card rendering
   - File sending/receiving

3. **Edge Case Analysis**: Check for:
   - Skills with overly broad trigger conditions (may false-trigger)
   - Skills that could conflict with each other
   - Missing error handling in skill instructions

#### 4.3 Code Quality Spot Check

Randomly select 2-3 source files and check:
- Code is well-documented
- Error handling is proper
- No obvious code smells
- TypeScript types are properly used

```bash
# Find source files
find packages -name "*.ts" -not -path "*/node_modules/*" -not -path "*/dist/*" | shuf -n 3
```

---

### Phase 5: Report Generation

#### 5.1 Compile Findings

Generate a structured report using the template below:

```markdown
## 🐕 Disclaude Self-Experience Report

**Version**: {version}
**Date**: {YYYY-MM-DD HH:mm}
**Environment**: {node version, platform}

---

### 📊 Health Check Summary

| Check | Status | Details |
|-------|--------|---------|
| Tests | ✅/❌ | X/Y passed ({pass_rate}%) |
| Type Check | ✅/❌ | {error_count} errors |
| Lint | ✅/❌ | {warning_count} warnings, {error_count} errors |
| Build | ✅/❌ | Duration: {build_time}s |

**Overall Health**: {emoji} {status}

---

### 🆕 New Feature Validation

| Feature | Status | Notes |
|---------|--------|-------|
| {feature_1} | ✅/❌ | {notes} |
| {feature_2} | ✅/❌ | {notes} |

---

### 🎯 Skill Health

| Skill | Status | Issues |
|-------|--------|--------|
| {skill_1} | ✅/⚠️/❌ | {issues or "OK"} |
| {skill_2} | ✅/⚠️/❌ | {issues or "OK"} |

**Total Skills**: {total} | **Healthy**: {healthy} | **Issues**: {issues}

---

### 🔍 User Experience Observations

#### Positive Findings
- {positive_observation_1}
- {positive_observation_2}

#### Areas for Improvement
- {improvement_1}
- {improvement_2}

#### Potential Issues
- {potential_issue_1}
- {potential_issue_2}

---

### 📋 Recommendations

| Priority | Recommendation | Type |
|----------|---------------|------|
| 🔴 High | {recommendation} | Bug/UX/Feature |
| 🟡 Medium | {recommendation} | Enhancement |
| 🟢 Low | {recommendation} | Documentation |

---

*Report generated by self-experience skill | Version {version}*
```

#### 5.2 Send Report

Use `send_user_feedback` to send the report to the user:

```
send_user_feedback({
  content: [The report in markdown format],
  format: "text",
  chatId: [The chatId from context]
})
```

---

### Phase 6: Critical Issue Handling (Optional)

#### 6.1 Decide Whether to Create Issues

Only create GitHub issues for **critical** findings:

**Create issue if:**
- Test suite has new failures (not pre-existing)
- Type check or build fails
- A skill is completely broken
- Security concerns found

**Do NOT create issue if:**
- Minor lint warnings
- Documentation improvements
- Nice-to-have enhancements

#### 6.2 Submit Critical Issues

If critical issues are found, use the `feedback` skill pattern to submit:

```bash
gh issue create --repo hs3180/disclaude \
  --title "[Self-Experience] {brief description}" \
  --body "{sanitized issue description}" \
  --label "bug"
```

**Sanitization rules** (from feedback skill):
- Remove user IDs, chat IDs, message IDs
- Remove API keys, tokens, passwords
- Remove file paths that might reveal sensitive information
- Remove URLs that might contain sensitive query parameters

---

## Schedule Integration

To enable periodic self-experience, create a schedule file in `schedules/self-experience.md`:

```markdown
---
name: "Self-Experience"
cron: "0 4 * * 1"  # Weekly on Monday at 4am
enabled: false
blocking: true
chatId: "{your_chat_id}"
---

请使用 self-experience skill 执行一次自我体验检查。

要求：
1. 分析当前版本的新功能
2. 运行自动化健康检查（测试、类型检查、lint）
3. 验证所有 skill 定义的有效性
4. 生成结构化报告并发送到当前 chatId
5. 仅对严重问题创建 GitHub issue

注意：
- 不要修改任何源代码
- 不要创建或修改定时任务
- 优先关注功能完整性和用户体验
```

---

## Example Scenarios

### Scenario 1: Post-Release Self-Experience

**Trigger**: After deploying a new version

**Expected Output**:
```markdown
## 🐕 Disclaude Self-Experience Report

**Version**: 0.4.0
**Date**: 2026-03-28 08:00

### 📊 Health Check Summary

| Check | Status | Details |
|-------|--------|---------|
| Tests | ✅ | 1481/1481 passed (100%) |
| Type Check | ✅ | 0 errors |
| Lint | ✅ | 0 warnings, 0 errors |
| Build | ✅ | Duration: 12s |

**Overall Health**: ✅ All checks passed

### 🆕 New Feature Validation

| Feature | Status | Notes |
|---------|--------|-------|
| Message Listener | ✅ | 18 tests passing |
| Research Mode | ✅ | Framework ready |
| Group Management | ✅ | MCP tools available |

### 📋 Recommendations

| Priority | Recommendation | Type |
|----------|---------------|------|
| 🟢 Low | Add more edge case tests for message deduplication | Enhancement |
```

### Scenario 2: Issues Found

**Trigger**: Regular weekly check

**Expected Output**:
```markdown
### 📊 Health Check Summary

| Check | Status | Details |
|-------|--------|---------|
| Tests | ❌ | 1478/1481 passed (99.8%) |
| Type Check | ✅ | 0 errors |
| Lint | ⚠️ | 3 warnings, 0 errors |
| Build | ✅ | Duration: 14s |

### 🔴 Critical Issues

1. **Test failure in `message-listener.test.ts`**: `should handle concurrent messages` - Timeout after 30s
   - Action: GitHub issue created #XXX
```

---

## Checklist

- [ ] Read version from package.json
- [ ] Analyzed CHANGELOG.md for recent changes
- [ ] Ran test suite and recorded results
- [ ] Ran type check and recorded results
- [ ] Ran lint and recorded results
- [ ] Verified build succeeds
- [ ] Scanned all skill definitions for validity
- [ ] Validated schedule definitions
- [ ] Analyzed recent chat logs for UX insights
- [ ] Generated structured report
- [ ] **Sent report via send_user_feedback** (CRITICAL)
- [ ] Created GitHub issues for critical findings (if any)

---

## DO NOT

- Modify any source code or configuration files
- Deploy, restart, or stop any services
- Create or modify scheduled tasks
- Include sensitive information (IDs, tokens, keys) in reports
- Submit GitHub issues for non-critical findings
- Skip any phase of the self-experience process
- Run destructive git operations
- Exceed 15 minutes total execution time (set timeouts)
