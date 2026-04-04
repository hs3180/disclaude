---
name: dogfooding
description: Automated post-deployment dogfooding specialist - simulates user interactions after version changes, runs exploration scenarios, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "版本验证", "功能测试", "模拟体验", or after deployment events. Can also be triggered manually via /dogfooding.
allowed-tools: [Read, Bash, Glob, Grep, Write, send_user_feedback]
---

# Dogfooding Skill

Automatically verify disclaude functionality after version changes by simulating realistic user interactions and generating structured feedback reports.

## When to Use This Skill

**Trigger this skill when:**

- After a new version is deployed or released
- User mentions "自我体验", "dogfooding", "版本验证", "功能测试", "模拟体验"
- Manual trigger via `/dogfooding`
- Scheduled task detects version change

## Single Responsibility

- ✅ Detect version changes and trigger dogfooding flow
- ✅ Execute predefined exploration scenarios
- ✅ Generate structured feedback reports
- ✅ Report findings via `send_user_feedback` or GitHub issues
- ❌ DO NOT modify source code or fix issues found
- ❌ DO NOT call task_done
- ❌ DO NOT evaluate task completion

---

## Core Principle

**Simulate a new user's perspective to discover UX issues that automated tests miss.**

Unlike unit/integration tests that verify specific code paths, dogfooding focuses on the holistic user experience: interaction quality, response accuracy, edge case handling, and workflow coherence.

---

## Workflow

### Phase 1: Version Change Detection

Compare the current version with the last tested version stored in state.

```bash
# Read current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")

# Read last tested version from state file
LAST_TESTED=$(cat workspace/.dogfooding-state.json 2>/dev/null | jq -r '.lastTestedVersion // "none"')

# Compare versions
if [ "$CURRENT_VERSION" = "$LAST_TESTED" ]; then
  echo "No version change detected. Skipping dogfooding."
  exit 0
fi
```

**If no version change**: Skip execution and report "no change detected".

**If version changed or first run**: Proceed to Phase 2.

### Phase 2: Scenario Execution

Execute a series of exploration scenarios. Each scenario tests a different aspect of the system.

#### Scenario Matrix

| #   | Scenario               | Category      | What It Tests                                  |
| --- | ---------------------- | ------------- | ---------------------------------------------- |
| 1   | Basic Chat Response    | Core          | Agent responds to a simple greeting            |
| 2   | Skill Discovery        | Discovery     | Agent lists available skills correctly         |
| 3   | Fuzzy Request          | Understanding | Agent handles vague/ambiguous requests         |
| 4   | Multi-turn Context     | Context       | Agent maintains context across messages        |
| 5   | Edge Case: Empty Input | Robustness    | Agent handles empty/null input gracefully      |
| 6   | Edge Case: Long Input  | Robustness    | Agent handles very long input without crashing |
| 7   | MCP Tool Invocation    | Integration   | Agent can invoke MCP tools successfully        |
| 8   | Error Recovery         | Resilience    | Agent recovers from invalid commands           |

#### Execution Method

For each scenario:

1. **Define the test input** (what a simulated user would say)
2. **Send the input** via the chat API or record it as a planned interaction
3. **Capture the response** (if running in live mode) or analyze expected behavior
4. **Evaluate the result** against acceptance criteria
5. **Record findings** in the results matrix

**Live Mode** (when running in a real chat environment):

```bash
# Send test message and capture response
# Use REST API or Feishu SDK to send messages
```

**Dry-Run Mode** (when running as a scheduled task without live chat):

- Analyze code paths statically
- Review recent logs for patterns
- Check system health indicators
- Verify configuration integrity

### Phase 3: Results Collection

Collect findings into a structured results matrix:

```markdown
| #   | Scenario            | Status     | Details                              |
| --- | ------------------- | ---------- | ------------------------------------ |
| 1   | Basic Chat Response | ✅ Pass    | Response within 5s, content relevant |
| 2   | Skill Discovery     | ✅ Pass    | Listed 18 skills correctly           |
| 3   | Fuzzy Request       | ⚠️ Partial | Responded but missed key intent      |
| ... | ...                 | ...        | ...                                  |
```

**Status Categories:**

- ✅ **Pass**: Behavior meets expectations
- ⚠️ **Partial**: Works but with issues (slow, incomplete, etc.)
- ❌ **Fail**: Does not work as expected
- ⏭️ **Skipped**: Cannot test in current environment

### Phase 4: Report Generation

Generate a structured feedback report:

```markdown
## 🐕 Dogfooding Report

**Version**: {current_version} (from {last_tested_version})
**Timestamp**: {ISO 8601 timestamp}
**Environment**: {deployment environment}
**Execution Mode**: {live/dry-run}

---

### 📊 Summary

| Metric          | Value           |
| --------------- | --------------- |
| Total Scenarios | {count}         |
| ✅ Passed       | {pass_count}    |
| ⚠️ Partial      | {partial_count} |
| ❌ Failed       | {fail_count}    |
| ⏭️ Skipped      | {skip_count}    |
| Pass Rate       | {percentage}%   |

---

### 🔍 Detailed Results

#### ✅ Scenario 1: Basic Chat Response

- **Input**: "你好，请介绍一下你自己"
- **Expected**: Friendly self-introduction within 5 seconds
- **Actual**: Responded in 2.3s with appropriate introduction
- **Verdict**: Pass

#### ⚠️ Scenario 3: Fuzzy Request

- **Input**: "那个东西怎么用"
- **Expected**: Ask clarifying question
- **Actual**: Gave generic response without clarification
- **Verdict**: Partial - should ask for more context
- **Suggestion**: Improve intent disambiguation for vague requests

---

### 🐛 Issues Found

#### Issue 1: [Brief Description]

- **Severity**: {High/Medium/Low}
- **Scenario**: #{number}
- **Description**: {detailed description}
- **Reproduction**: {steps to reproduce}
- **Suggested Fix**: {recommendation}

---

### 💡 Improvement Suggestions

1. [Suggestion 1]
2. [Suggestion 2]

---

### ✅ Highlights

- [Things that work well]
- [Positive observations]
```

### Phase 5: Report Delivery

**CRITICAL**: Always deliver the report using `send_user_feedback`.

```
send_user_feedback({
  format: "text",
  content: [The full report in markdown format],
  chatId: [The chatId from context]
})
```

If running as a scheduled task without chatId, save the report to a file:

```
workspace/reports/dogfooding-{version}-{timestamp}.md
```

### Phase 6: State Update

After successful execution, update the state file:

```bash
# Update last tested version
echo '{"lastTestedVersion": "'"$CURRENT_VERSION"'", "lastTestedAt": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'", "lastReport": "workspace/reports/dogfooding-'"$CURRENT_VERSION"'.md"}' > workspace/.dogfooding-state.json
```

---

## Dry-Run Mode Details

When running as a scheduled task (no live chat context), perform these checks instead:

### Health Checks

1. **Process Health**

   ```bash
   # Check if disclaude processes are running
   pm2 list 2>/dev/null || echo "PM2 not available"
   ```

2. **Configuration Integrity**

   ```bash
   # Verify config file is valid
   cat disclaude.config.yaml | head -5
   ```

3. **Recent Error Analysis**

   ```bash
   # Check recent logs for errors
   pm2 logs --lines 50 --nostream 2>/dev/null | grep -i "error\|fail\|exception" | tail -20
   ```

4. **Skill Loading Verification**

   ```bash
   # Verify all skills are discoverable
   ls skills/*/SKILL.md 2>/dev/null | wc -l
   ```

5. **Schedule Health**

   ```bash
   # Check schedule files are valid
   ls schedules/*.md 2>/dev/null | wc -l
   ```

6. **GitHub API Connectivity**

   ```bash
   # Verify gh CLI is working
   gh api user --jq '.login' 2>/dev/null
   ```

7. **Dependency Status**
   ```bash
   # Check for outdated dependencies
   npm outdated --json 2>/dev/null | head -20
   ```

---

## Context Variables

When invoked, you receive:

- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Checklist

- [ ] Checked for version changes
- [ ] Executed all applicable scenarios
- [ ] Recorded results for each scenario
- [ ] Generated structured feedback report
- [ ] **Delivered report via send_user_feedback** (CRITICAL)
- [ ] Updated state file with last tested version
- [ ] Created issues for critical findings (if any)

---

## DO NOT

- ❌ Modify source code to fix issues found during dogfooding
- ❌ Create or modify scheduled tasks
- ❌ Skip the report delivery step
- ❌ Include sensitive information (API keys, tokens, user IDs) in reports
- ❌ Run destructive operations (delete, reset, force push)
- ❌ Execute scenarios that could affect production data
- ❌ Call task_done or evaluate task completion
