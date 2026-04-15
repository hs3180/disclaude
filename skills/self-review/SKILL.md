---
name: self-review
description: Automated self-review specialist - checks system health, discovers skills, analyzes logs for errors, and generates structured reports. Use for automated dogfooding, health checks, or when user says keywords like "自我检查", "健康检查", "self-review", "dogfood", "自检". Triggered by scheduler or manually via /self-review.
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Self-Review Skill

Automated self-review and health-check specialist for disclaude.

Performs a structured self-diagnostic, covering version info, skill availability, log analysis, and configuration validation. Generates a human-readable report and delivers it to the configured chat.

## When to Use This Skill

**Use this skill for:**
- Periodic automated self-health checks (dogfooding)
- Post-deployment smoke tests
- Manual ad-hoc diagnostics via `/self-review`
- Change-impact analysis after config or skill changes

**Keywords that trigger this skill**: "自我检查", "健康检查", "self-review", "dogfood", "自检", "diagnostic"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from context)
- **Message ID**: Message ID (from context)

---

## Review Process

### Step 1: Gather Version Information

```bash
# Read version from package.json
node -e "const p = require('./package.json'); console.log(JSON.stringify({name:p.name, version:p.version}))"
```

Record the current version and name.

### Step 2: Discover Available Skills

Use `Glob` to find all skill files:

```
skills/*/SKILL.md
.claude/skills/*/SKILL.md
```

For each skill found:
1. Read the frontmatter (`name`, `description`, `allowed-tools`)
2. Record it in the report

**Check**: Verify that core skills exist (feedback, executor, evaluator).

### Step 3: Analyze Recent Logs for Errors

```bash
# Find the latest combined log file
ls -t logs/disclaude-combined.log* 2>/dev/null | head -1
```

Use `Grep` to search for error patterns in the log file:

```
# Error patterns to check
"level":40  # warn
"level":50  # error
"level":60  # fatal
"err":"     # error objects
"Error:"    # error messages
```

Focus on the **last 24 hours**. Count occurrences and categorize.

### Step 4: Validate Configuration

Check that the config file loads correctly:

```bash
# Check config exists
test -f disclaude.config.yaml && echo "Config exists" || echo "No config file"
```

Verify key configuration sections:
- `feishu` section exists (app_id, app_secret)
- `agent` section exists (model)
- `workspace.dir` is set
- `mcpServers` section exists (even if empty)

### Step 5: Check Schedule Health

List all schedule files and their status:

```bash
ls schedules/*.md 2>/dev/null
```

For each schedule, note:
- Name
- Cron expression
- Whether it's enabled
- Last modified time

### Step 6: Test Infrastructure

Quick smoke tests of core infrastructure:

```bash
# Node.js version
node --version

# npm availability
npm --version

# TypeScript compilation check (dry-run)
npx tsc --noEmit 2>&1 | tail -5
```

### Step 7: Generate Report

Create a structured self-review report:

```markdown
## 🏥 Self-Review Report

**Generated**: [ISO Timestamp]
**Version**: [name@version]
**Node.js**: [version]

---

### ✅ Health Summary

| Category | Status | Details |
|----------|--------|---------|
| Version | ✅/⚠️/❌ | [version string] |
| Skills | ✅/⚠️ | [X skills discovered] |
| Logs | ✅/⚠️/❌ | [X errors in last 24h] |
| Config | ✅/⚠️ | [sections validated] |
| Schedules | ✅/⚠️ | [X schedules, Y enabled] |
| Infrastructure | ✅/⚠️ | [Node + TypeScript status] |

---

### 📦 Skills Inventory

| Skill | Domain | Description |
|-------|--------|-------------|
| [name] | [package/workspace/project] | [brief description] |

---

### 📊 Log Analysis (Last 24h)

- **Warnings**: X
- **Errors**: X
- **Fatal**: X

[Top 3 error patterns with counts]

---

### ⚠️ Issues Found

[List any issues discovered, or "None" if all checks passed]

---

### 💡 Recommendations

[Suggestions for improvement based on the findings]

---

### 📋 Next Steps

1. [If errors found]: Investigate and fix top error patterns
2. [If skills missing]: Verify skill directory structure
3. [If config issues]: Review and update configuration
4. [If all healthy]: No immediate action needed
```

### Step 8: Deliver Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- chatId: [The chatId from context]
- content: [The report in markdown format]
- format: "text"
```

---

## Error Severity Guidelines

| Severity | Criteria | Action |
|----------|----------|--------|
| 🔴 Critical | Fatal errors, missing config, no skills | Immediate attention needed |
| 🟡 Warning | Error patterns, missing optional config | Review when convenient |
| 🟢 Healthy | No errors, all checks pass | No action needed |

## Report Delivery Rules

1. **Always** send the report via `send_user_feedback`
2. **Never** create GitHub Issues directly from self-review (use `/feedback` for that)
3. **Never** modify any configuration or code during self-review
4. **Never** include sensitive data (tokens, keys, user IDs) in the report

## DO NOT

- ❌ Modify any files during self-review (read-only operation)
- ❌ Create schedules or tasks (this is a diagnostic tool)
- ❌ Include API keys, tokens, or user IDs in reports
- ❌ Attempt to fix issues found (only report them)
- ❌ Send reports to chatIds not in the current context
- ❌ Execute destructive commands or write operations

## Example Report

```markdown
## 🏥 Self-Review Report

**Generated**: 2026-04-15T09:00:00Z
**Version**: disclaude@0.4.0
**Node.js**: v22.22.2

---

### ✅ Health Summary

| Category | Status | Details |
|----------|--------|---------|
| Version | ✅ | disclaude@0.4.0 |
| Skills | ✅ | 22 skills discovered |
| Logs | ⚠️ | 3 errors in last 24h |
| Config | ✅ | All sections present |
| Schedules | ✅ | 6 schedules, 1 enabled |
| Infrastructure | ✅ | Node v22.22.2, TypeScript OK |

---

### 📊 Log Analysis (Last 24h)

- **Warnings**: 12
- **Errors**: 3
- **Fatal**: 0

Top errors:
1. `IPC timeout` (2 occurrences) — connection to worker node
2. `Rate limit exceeded` (1 occurrence) — API rate limit

---

### 💡 Recommendations

1. Investigate IPC timeout pattern — may indicate worker node instability
2. Consider increasing API rate limit buffer
```

---

## Checklist

- [ ] Gathered version information
- [ ] Discovered all available skills
- [ ] Analyzed recent logs for errors
- [ ] Validated configuration
- [ ] Checked schedule health
- [ ] Tested infrastructure (Node.js, TypeScript)
- [ ] Generated structured report
- [ ] **Sent report via send_user_feedback** (CRITICAL)
