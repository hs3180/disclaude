---
name: dogfood
description: Self-testing (dogfooding) skill that systematically exercises all available skills, validates their behavior, and generates a structured quality report. Use when user says "自我测试", "dogfood", "体验测试", "质量检查", "技能测试", "self-test", "auto-test", "体验最新版本".
allowed-tools: Read, Glob, Grep, Bash, WebSearch, send_user_feedback
---

# Dogfood: Self-Testing Skill

Automatically test and evaluate all available skills, simulating real user interactions to discover issues, validate behavior, and generate a quality report.

## When to Use This Skill

**Use this skill for:**
- Automatically testing all available skills after a new release
- Running quality checks on skill functionality
- Discovering broken or misbehaving skills
- Generating a "self-experience" report for developers
- Validating that the latest version works correctly

**Keywords that trigger this skill**: "自我测试", "dogfood", "体验测试", "质量检查", "技能测试", "self-test", "auto-test", "体验最新版本", "dogfooding"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Simulate a curious new user exploring the system.** Rather than running fixed test suites, approach each skill as if you were a first-time user trying to understand and use it. This uncovers UX issues that unit tests cannot detect.

## Testing Process

### Step 1: Discover All Skills

List all available skills by reading the skills directory:

```bash
ls -d skills/*/SKILL.md 2>/dev/null
```

For each skill found, read its SKILL.md to understand:
- What it does (from `description` in frontmatter)
- How it's invoked (from `name` and `argument-hint`)
- What tools it uses (from `allowed-tools`)

### Step 2: Classify Skills

Group skills into test categories:

| Category | Test Approach | Examples |
|----------|--------------|---------|
| **Analysis** | Run with sample data | `daily-chat-review`, `daily-soul-question` |
| **Action** | Validate tool availability | `feedback`, `github-app`, `github-jwt-auth` |
| **Interactive** | Check description clarity | `chat`, `bbs-topic-initiator` |
| **Internal** | Verify file existence | `evaluator`, `executor`, `next-step` |
| **Browser** | Check config only | `site-miner`, `playwright-agent` |

### Step 3: Execute Tests

For each skill, perform the following checks:

#### 3.1 Static Checks (All Skills)

1. **SKILL.md exists**: Verify the file is present and readable
2. **Frontmatter valid**: Check `description` field exists and is non-empty
3. **Content quality**: Verify the SKILL.md has structured content (headings, steps)
4. **Allowed tools**: List declared tools and verify they're reasonable

```
For each skill in skills/:
  1. Read skills/{name}/SKILL.md
  2. Check: Does it have a YAML frontmatter section?
  3. Check: Does the frontmatter have a 'description' field?
  4. Check: Is the description meaningful (>20 chars)?
  5. Check: Does the body have at least 2 headings?
  6. Record results in a structured format
```

#### 3.2 Dynamic Checks (Selectable Skills)

For skills that can be tested without side effects:

1. **Discovery test**: Verify the skill can be found by name
2. **Description relevance**: Verify the description accurately describes the skill content
3. **Dependency check**: Verify referenced files/tools exist
4. **Edge case handling**: Check if the skill handles common edge cases (mentioned in content)

#### 3.3 Test Scenario Generation

For each skill, generate a realistic test scenario based on its description:

```markdown
### Test Scenario: {skill_name}
**Input**: Simulated user request matching the skill's trigger keywords
**Expected**: Skill should be activated and produce relevant output
**Actual**: [To be filled during testing]
**Status**: [PASS/FAIL/SKIP]
```

### Step 4: Validate Core Infrastructure

Beyond individual skills, test the core system components:

```bash
# Check package structure integrity
ls packages/core/src/skills/finder.ts
ls packages/core/src/scheduling/scheduler.ts
ls packages/core/src/config/

# Verify build works (if applicable)
# npm run type-check 2>&1 | tail -20

# Check test infrastructure
ls vitest.config.ts
```

### Step 5: Generate Report

Create a structured report summarizing all test results:

```markdown
# Dogfood Test Report

**Test Date**: [ISO timestamp]
**Version**: [from package.json version]
**Duration**: [approximate]

---

## Summary

| Metric | Count |
|--------|-------|
| Total Skills | X |
| Passed | X |
| Failed | X |
| Skipped | X |
| Pass Rate | X% |

---

## Skill Results

### PASS Skills
- [List of skills that passed all checks]

### FAIL Skills
- [List of skills with issues, including specific failures]

### SKIP Skills
- [List of skills that were skipped, with reasons]

---

## Issues Found

### [Issue Title]
- **Skill**: [skill name]
- **Severity**: [HIGH/MEDIUM/LOW]
- **Description**: [What's wrong]
- **Recommendation**: [How to fix]

---

## Quality Metrics

| Check | Result |
|-------|--------|
| All skills discoverable | Yes/No |
| All SKILL.md valid | Yes/No |
| Descriptions meaningful | X/Y |
| Content structured | X/Y |
| Infrastructure intact | Yes/No |

---

## Highlights

- [Notable positive findings]
- [Interesting discoveries]
- [Unexpected behaviors]
```

### Step 6: Send Report

**CRITICAL**: Always send the report to the user using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The full report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Testing Rules

### What to Test
- ✅ Every skill's SKILL.md exists and is readable
- ✅ Frontmatter has required `description` field
- ✅ Content is well-structured with headings and steps
- ✅ Referenced files/tools exist where checkable
- ✅ Core infrastructure files are intact

### What NOT to Test
- ❌ Don't actually invoke external APIs (GitHub, Feishu, etc.)
- ❌ Don't create real resources (issues, PRs, chat groups)
- ❌ Don't modify any files (read-only testing)
- ❌ Don't run `npm run build` or `npm run test` (too expensive)
- ❌ Don't test skills that require real browser interaction

### Severity Classification

| Severity | Criteria |
|----------|----------|
| **HIGH** | Skill completely broken, missing SKILL.md, or frontmatter invalid |
| **MEDIUM** | Description misleading, missing important documentation |
| **LOW** | Minor formatting issues, could improve clarity |

---

## Example Execution

### Input (User Request):
```
"帮我测试一下所有功能是否正常"
```

### Output (Report Excerpt):

```markdown
# Dogfood Test Report

**Test Date**: 2026-04-18T07:00:00Z
**Version**: 0.4.0

## Summary

| Metric | Count |
|--------|-------|
| Total Skills | 19 |
| Passed | 17 |
| Failed | 0 |
| Skipped | 2 |
| Pass Rate | 100% |

### SKIP Skills
- `playwright-agent` — Requires browser environment
- `site-miner` — Requires browser environment

## Quality Metrics

| Check | Result |
|-------|--------|
| All skills discoverable | Yes |
| All SKILL.md valid | Yes |
| Descriptions meaningful | 19/19 |
| Content structured | 19/19 |
| Infrastructure intact | Yes |

## Highlights
- All 19 skills have valid SKILL.md with meaningful descriptions
- `daily-chat-review` has excellent pattern detection guidelines
- `next-step` provides clear interactive card templates
```

---

## Checklist

- [ ] Discovered all available skills
- [ ] Performed static checks on every skill
- [ ] Generated test scenarios for testable skills
- [ ] Validated core infrastructure integrity
- [ ] Generated structured quality report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- ❌ Create or modify any files in the repository
- ❌ Invoke external APIs or services
- ❌ Run expensive operations (build, test suite)
- ❌ Send reports to wrong chatId
- ❌ Skip the send_user_feedback step
- ❌ Include sensitive information in reports
- ❌ Test skills that require physical hardware (browser, screen)
