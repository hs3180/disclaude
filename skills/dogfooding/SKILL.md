---
name: dogfooding
description: Self-experience (dogfooding) specialist - autonomously explores disclaude features from a new user perspective and generates structured feedback reports. Use when user asks for self-testing, dogfooding, feature exploration, or says keywords like "自我体验", "dogfooding", "自动体验", "功能探索", "self-experience", "feature exploration".
allowed-tools: Read, Glob, Grep, Bash, WebSearch, Task
---

# Dogfooding - Self-Experience Specialist

Autonomously explore disclaude's own capabilities from a "new user" perspective, simulate real-world usage scenarios, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Running self-experience sessions to validate feature quality
- Exploring disclaude features from a new user's point of view
- Generating structured feedback reports after self-exploration
- Testing edge cases and integration scenarios
- Verifying skill functionality end-to-end

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自动体验", "功能探索", "self-experience", "feature exploration", "self-test"

## Core Principle

**Use prompt-based exploration, NOT scripted test cases.**

The agent should freely explore features like a curious new user, not follow rigid test scripts. The goal is to discover UX issues that automated tests miss.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Exploration Strategy

### Phase 1: Capability Discovery (5-8 activities)

Randomly select exploration activities from the pool below. **Do NOT follow a fixed order** — vary the selection each session to cover different areas.

#### Activity Pool

| Category | Activities |
|----------|-----------|
| **Skill Testing** | Invoke a random skill from `skills/` and verify it works correctly. Check: Does it load? Does it produce useful output? Are error messages helpful? |
| **Conversation Quality** | Start a multi-turn conversation on a random topic. Test: Does context carry across turns? Are responses relevant? Is the tone appropriate? |
| **Edge Case Simulation** | Send edge-case inputs: empty messages, extremely long input (>5000 chars), mixed languages, ambiguous requests, special characters |
| **Tool Integration** | Test MCP tools if available: `send_interactive`, `create_chat`, `send_file`. Verify card rendering and interaction flow |
| **Documentation Accuracy** | Read `CLAUDE.md` and `README.md`, then verify claims match actual behavior (e.g., commands, configuration, architecture) |
| **Code Quality Review** | Run `npm run type-check` and `npm run lint`. Report any issues found |
| **Test Health Check** | Run `npm run test` and analyze: pass rate, slow tests, flaky indicators, coverage gaps |
| **Feature Combination** | Try combining multiple features: e.g., start a discussion then use a skill within it, or trigger a schedule and verify the output |

### Phase 2: Observation & Documentation

For each activity, record:

```
### Activity: {name}
- **Category**: {category}
- **Approach**: {how the exploration was conducted}
- **Observation**: {what happened}
- **Issue Found**: {description} / None
- **Severity**: bug | improvement | suggestion |亮点
- **Suggestion**: {specific improvement idea} / N/A
```

### Phase 3: Feedback Report Generation

Compile all observations into a structured report.

---

## Report Template

```markdown
## 🐕 Disclaude 自我体验报告

**体验时间**: {date}
**体验版本**: {version from package.json}
**活动数量**: {count}

### 📊 总览

| 指标 | 结果 |
|------|------|
| 探索活动数 | {N} |
| 发现问题数 | {bugs} bug + {improvements} improvement |
| 亮点数 | {highlights} |
| 整体评分 | ⭐⭐⭐⭐⭐ (1-5) |

### 🔍 活动详情

{Phase 2 observations}

### 🐛 发现的问题

#### Bug (严重程度: 高/中/低)
{bug descriptions}

#### 改进建议
{improvement suggestions}

### ✨ 亮点

{things that worked well}

### 📋 总结与建议

{overall assessment and top 3 actionable recommendations}
```

---

## Exploration Guidelines

### Do:
- ✅ Act like a genuine new user — be curious, ask questions, try unexpected things
- ✅ Vary activities across sessions — don't repeat the same exploration pattern
- ✅ Record both positive and negative findings
- ✅ Provide specific, actionable suggestions
- ✅ Test real workflows, not isolated features

### Don't:
- ❌ Follow a predetermined test script
- ❌ Only test happy paths — actively seek edge cases
- ❌ Report vague issues without specific reproduction steps
- ❌ Skip documentation verification
- ❌ Modify any code or configuration during exploration
- ❌ Create or delete files in the repository

---

## Sending the Report

Use the `send_user_feedback` MCP tool to send the report:

```
send_user_feedback({
  chatId: "{target_chat_id}",
  message: "{feedback_report}"
})
```

---

## Version Detection

At the start of each session, detect the current version:

```bash
# Get version from package.json
cat package.json | grep '"version"' | head -1

# Get latest changes
git log --oneline -10

# Check for uncommitted changes
git status --short
```

Include this information in the report header.

---

## Session Variance

To ensure each session explores different areas, use the current date as a seed for activity selection:

1. Count the total number of activity categories (8)
2. Use `(day_of_year % 8)` as the starting category
3. Select 5-8 activities in a rotating pattern from the starting point
4. This ensures full coverage over multiple sessions while keeping each session focused

---

## Integration with Other Skills

- **feedback**: Use `/feedback` to submit critical bugs discovered during exploration
- **daily-chat-review**: Cross-reference with daily chat reviews for recurring issues
- **schedule-recommend**: Analyze patterns across multiple dogfooding sessions

---

## Checklist

- [ ] Detected current version and recent changes
- [ ] Selected varied exploration activities (5-8)
- [ ] Conducted each activity from a new user perspective
- [ ] Recorded observations for each activity
- [ ] Categorized findings (bug/improvement/highlight)
- [ ] Generated structured feedback report
- [ ] Sent report to target chat/group

---

## DO NOT

- Modify any code, config, or data files during exploration
- Execute destructive operations (delete, reset, force push)
- Create or close GitHub issues automatically
- Skip the report generation step
- Repeat the exact same activities every session
- Explore beyond the scope of disclaude's own features
