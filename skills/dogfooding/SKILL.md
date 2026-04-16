---
name: dogfooding
description: Self-testing and dogfooding specialist - discovers system capabilities, simulates user interactions, and generates structured quality reports. Use when user says keywords like "自我测试", "dogfooding", "体验测试", "自检", "self-test", "系统体检", "health check", "capability audit". Triggered by scheduler for periodic automated execution.
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Dogfooding: Auto-Experience & Self-Testing

Simulate a new user exploring the system, test available capabilities, and generate a structured quality report.

## When to Use This Skill

**Use this skill for:**
- Periodic self-testing of system capabilities
- Verifying that all registered skills are discoverable and loadable
- Checking build, lint, and test health
- Generating a capability audit report
- Simulating user scenarios against available skills

**Keywords that trigger this skill**: "自我测试", "dogfooding", "体验测试", "自检", "self-test", "系统体检", "health check", "capability audit", "auto experience"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Execution Process

### Phase 1: Environment Discovery

Discover the current system state and available capabilities.

#### 1.1 Version Check

Read the current version:

```bash
cat package.json | grep '"version"' | head -1
```

#### 1.2 Skill Inventory

Discover all available skills:

```
Use Glob to find: skills/*/SKILL.md
```

For each skill found, read the YAML frontmatter (first 10 lines) to extract:
- `name`: Skill name
- `description`: What the skill does
- `allowed-tools`: Tools it uses
- `disable-model-invocation`: Whether it's manual-only

#### 1.3 Schedule Inventory

Discover all configured schedules:

```
Use Glob to find: schedules/*.md
```

For each schedule, read the YAML frontmatter to extract:
- `name`: Schedule name
- `cron`: Cron expression
- `enabled`: Whether it's active

#### 1.4 System Health Check

Run basic health checks:

```bash
# Check if build succeeds (quick check with type-check only)
npm run type-check 2>&1 | tail -5

# Check lint status
npm run lint 2>&1 | tail -5
```

---

### Phase 2: Capability Assessment

Assess each discovered capability against quality criteria.

#### 2.1 Skill Quality Assessment

For each skill, evaluate:

| Criterion | Check Method | Pass Condition |
|-----------|-------------|----------------|
| **Discoverable** | SKILL.md exists in expected path | File found via Glob |
| **Valid Frontmatter** | YAML between `---` delimiters | Has `name` and `description` |
| **Description Quality** | Description length and keywords | >= 20 chars, includes use-case keywords |
| **Tool Specified** | `allowed-tools` field present | Field exists |
| **Instructions Present** | Body content after frontmatter | >= 100 chars of instructions |

#### 2.2 Schedule Quality Assessment

For each schedule, evaluate:

| Criterion | Check Method | Pass Condition |
|-----------|-------------|----------------|
| **Valid Cron** | Cron expression parseable | Standard 5-field format |
| **ChatId Set** | `chatId` field present | Non-empty value |
| **Has Instructions** | Body content after frontmatter | >= 50 chars |

#### 2.3 Scenario Simulation

Generate 3-5 realistic user scenarios based on discovered skills. For each scenario:

1. Pick a skill that would handle the scenario
2. Describe the simulated user input
3. Check if the skill's description matches the scenario keywords
4. Assess whether the skill would be auto-invoked or needs manual trigger

Example scenarios:
- User asks "帮我分析一下最近的聊天记录" -> Should trigger `daily-chat-review`
- User says "生成一个讨论话题" -> Should trigger `bbs-topic-initiator`
- User asks "帮我创建一个自定义功能" -> Should trigger `skill-creator`
- User says "检查网站内容" -> Should trigger `site-miner`

---

### Phase 3: Report Generation

Generate a structured dogfooding report.

#### Report Format

```markdown
# Dogfooding Report

**Generated**: [ISO timestamp]
**Version**: [from package.json]
**Duration**: [approximate execution time]

---

## Summary

| Metric | Value |
|--------|-------|
| Total Skills | [count] |
| Skills Passing All Checks | [count] |
| Schedules (Enabled/Total) | [enabled]/[total] |
| Build Status | [pass/fail] |
| Lint Status | [pass/fail] |
| Overall Health | [good/warning/critical] |

---

## Skill Inventory

| Skill | Description (truncated) | Auto-invocable | Quality Score |
|-------|------------------------|----------------|---------------|
| [name] | [first 50 chars] | [yes/no] | [A/B/C/F] |

**Quality Score Guide:**
- **A**: All criteria passed
- **B**: Minor issues (e.g., short description)
- **C**: Missing tools or incomplete instructions
- **F**: Major issues (missing frontmatter, no instructions)

---

## Schedule Inventory

| Schedule | Cron | Enabled | Status |
|----------|------|---------|--------|
| [name] | [cron] | [yes/no] | [valid/invalid] |

---

## Scenario Simulation Results

### Scenario 1: [Title]
- **Simulated Input**: "[user message]"
- **Expected Skill**: [skill name]
- **Match Found**: [yes/no]
- **Auto-trigger**: [yes/no]
- **Assessment**: [brief assessment]

[... more scenarios ...]

---

## Issues Found

### [Priority] Issue Title
- **Category**: [skill-quality / schedule-config / build / lint]
- **Details**: [description]
- **Recommendation**: [suggested fix]

---

## Highlights

- [List of things working well]
- [Notable improvements since last check]

---

## Recommendations

1. **[Priority]**: [Recommendation]
2. **[Priority]**: [Recommendation]

---

*Report generated by Dogfooding Skill (Phase 1)*
```

---

### Phase 4: Send Report

**CRITICAL**: Always send the report to the user using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Health Assessment Rules

### Overall Health Score

| Level | Condition |
|-------|-----------|
| **Good** | All skills >= B, build passes, lint passes |
| **Warning** | Some skills rated C, or build/lint has warnings |
| **Critical** | Skills rated F, build fails, or lint fails |

### Priority Classification

| Priority | Label | Description |
|----------|-------|-------------|
| P0 | **Critical** | Build failure, missing core skill |
| P1 | **High** | Skill without description, schedule with invalid cron |
| P2 | **Medium** | Short descriptions, missing tool specs |
| P3 | **Low** | Cosmetic issues, documentation gaps |

---

## Execution Guidelines

### DO:
- Be thorough but efficient - don't spend more than 2 minutes on this task
- Focus on actionable findings
- Report both good and bad findings
- Keep the report concise and scannable
- Use tables for easy reading

### DO NOT:
- Actually invoke other skills during testing (just assess them)
- Modify any files during the dogfooding run
- Send messages to other chats
- Run full test suites (too slow for periodic execution)
- Create issues or PRs automatically
- Report on skills you cannot read (note them as inaccessible)

---

## Checklist

- [ ] Read package.json version
- [ ] Discovered all skills via Glob
- [ ] Read frontmatter for each skill
- [ ] Assessed quality of each skill
- [ ] Discovered all schedules
- [ ] Checked build status
- [ ] Checked lint status
- [ ] Generated scenario simulations
- [ ] Created structured report
- [ ] **Sent report via send_user_feedback** (CRITICAL)
