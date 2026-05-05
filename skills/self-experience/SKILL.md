---
name: self-experience
description: Self-experience (dogfooding) module - automatically explores own features from a new-user perspective, simulates diverse interactions, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验".
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Self-Experience (Dogfooding)

Automatically explore own features from a new-user perspective, simulate diverse interactions, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Dogfooding: testing own features by acting as a new user
- Automated feature exploration and validation
- Generating self-feedback reports with improvement suggestions
- Simulating diverse user interactions across available skills

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Act as a brand-new user exploring the system for the first time.**

The goal is to discover UX issues, feature gaps, and improvement opportunities that developers (who are deeply familiar with the system) might overlook. Approach everything with fresh eyes and genuine curiosity.

---

## Exploration Process

### Step 1: Discover Available Features

Scan the system to understand what's available:

```bash
# List all available skills
ls skills/*/SKILL.md

# Read the main configuration
cat CLAUDE.md 2>/dev/null || echo "No CLAUDE.md found"

# Check available commands and features
ls -la *.md 2>/dev/null
```

For each skill found, read its SKILL.md to understand:
- What the skill does
- What tools it needs
- What keywords trigger it
- What user scenarios it supports

### Step 2: Design Exploration Plan

Based on the discovered features, create a **diverse exploration plan** covering:

| Category | Exploration Focus | Example Actions |
|----------|-------------------|-----------------|
| **Basic Interaction** | Chat quality, response accuracy | Ask simple questions, test multi-turn conversations |
| **Skill Invocation** | Skill discovery, trigger accuracy | Try each skill with expected/unexpected keywords |
| **Edge Cases** | Error handling, graceful degradation | Empty inputs, very long inputs, mixed languages |
| **Integration** | Cross-feature workflows | Combine multiple skills in sequence |
| **Help & Discovery** | Onboarding, self-documentation | Ask "what can you do?", try help commands |

**Selection rules:**
- Pick 3-5 diverse skill categories to explore
- Include at least 1 edge-case scenario
- Include at least 1 integration scenario
- Prioritize recently added or modified skills

### Step 3: Execute Exploration Scenarios

For each scenario, simulate the interaction and record observations:

#### 3.1 Simulate the Interaction

Think through what a real user would do:
1. **What would the user say?** — Formulate a natural, possibly imprecise request
2. **What would the system do?** — Trace through the expected behavior based on SKILL.md
3. **What would the user experience?** — Note response time, clarity, helpfulness
4. **What could go wrong?** — Identify potential failure points

#### 3.2 Record Observations

For each scenario, document:

```markdown
#### Scenario: [Name]
- **Category**: [Basic/Skill/Edge Case/Integration/Help]
- **User Intent**: [What the user wants to achieve]
- **Simulated Input**: "[What the user would type]"
- **Expected Behavior**: [What should happen]
- **Actual Assessment**: [Based on code/log analysis, what would actually happen]
- **Issues Found**: [Any problems discovered]
- **UX Score**: [1-5, where 5 = excellent, 1 = broken]
- **Improvement Suggestions**: [Specific actionable suggestions]
```

### Step 4: Analyze Recent Issues and Feedback

Check for recurring problems reported by real users:

```bash
# Check recent closed issues for patterns
gh issue list --repo hs3180/disclaude --state closed --limit 10 --json title,labels

# Check recent open issues
gh issue list --repo hs3180/disclaude --state open --limit 10 --json title,labels
```

Cross-reference exploration findings with real user reports:
- Are exploration-discovered issues also reported by users?
- Are there user-reported issues that the exploration missed?
- Are there systemic patterns across both sources?

### Step 5: Generate Feedback Report

Create a structured report:

```markdown
## 🐕 自我体验报告 (Dogfooding Report)

**探索时间**: [Timestamp]
**探索范围**: [Number of skills/features tested]
**探索场景数**: [Number of scenarios executed]

---

### 📊 总体评估

| 维度 | 评分 (1-5) | 说明 |
|------|-----------|------|
| 功能完整性 | ⭐⭐⭐⭐⭐ | [Assessment] |
| 易用性 | ⭐⭐⭐⭐⭐ | [Assessment] |
| 错误处理 | ⭐⭐⭐⭐⭐ | [Assessment] |
| 帮助与文档 | ⭐⭐⭐⭐⭐ | [Assessment] |
| 响应质量 | ⭐⭐⭐⭐⭐ | [Assessment] |

**综合评分**: X.X/5.0

---

### ✅ 亮点 (What Works Well)

1. **[Feature Name]**: [Why it's good]
2. **[Feature Name]**: [Why it's good]
3. **[Feature Name]**: [Why it's good]

---

### 🔴 问题发现 (Issues Found)

#### 问题 1: [Issue Title]
- **严重程度**: 🔴 Critical / 🟡 Major / 🟢 Minor
- **影响场景**: [Which scenarios are affected]
- **复现步骤**:
  1. [Step 1]
  2. [Step 2]
  3. [Step 3]
- **预期行为**: [What should happen]
- **实际行为**: [What actually happens]
- **建议修复**: [How to fix it]

---

### 🟡 改进建议 (Improvement Suggestions)

#### 建议 1: [Suggestion Title]
- **优先级**: High / Medium / Low
- **当前状态**: [How it works now]
- **建议改进**: [How it should work]
- **预期收益**: [Expected benefit]

---

### 🧪 探索场景详情

<details>
<summary>点击展开所有场景详情</summary>

#### 场景 1: [Name]
- **Category**: [Category]
- **Simulated Input**: "[input]"
- **Expected**: [expected behavior]
- **Assessment**: [what happened]
- **UX Score**: X/5

#### 场景 2: [Name]
...

</details>

---

### 📋 建议的下一步 (Recommended Next Steps)

1. **立即修复**: [Critical issues]
2. **计划改进**: [Medium-priority improvements]
3. **持续观察**: [Low-priority items]
```

### Step 6: Send Report

**CRITICAL**: Always send the report to the user using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Exploration Guidelines

### What Makes a Good Exploration

| Good Exploration | Bad Exploration |
|-----------------|-----------------|
| Approaches features as a newcomer | Tests with developer-level knowledge |
| Tries imprecise/natural language | Uses exact keywords only |
| Explores edge cases and boundaries | Only tests happy paths |
| Combines features in unexpected ways | Tests features in isolation |
| Documents subjective UX impressions | Only records objective pass/fail |

### Scenario Design Tips

1. **Vary user expertise levels**: novice, intermediate, power user
2. **Vary input quality**: clear requests, vague requests, typos
3. **Vary languages**: Chinese, English, mixed
4. **Vary complexity**: simple single-step, multi-step workflows
5. **Test error recovery**: what happens after a mistake?

### Quality Assessment Criteria

**UX Score Guide:**
- **5/5 (Excellent)**: Intuitive, fast, helpful, no issues
- **4/5 (Good)**: Works well, minor friction points
- **3/5 (Acceptable)**: Gets the job done, but could be much better
- **2/5 (Poor)**: Confusing or requires significant effort
- **1/5 (Broken)**: Doesn't work or gives wrong results

---

## Integration with Scheduling

This skill can be triggered by the scheduler for periodic self-testing:

```markdown
---
name: "自我体验 (Dogfooding)"
cron: "0 10 * * 1"     # Every Monday at 10:00 AM
enabled: false
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
createdAt: "TIMESTAMP"
---

# 自我体验 (Dogfooding)

每周一 10:00 自动进行功能自我体验，从新用户视角探索系统功能，生成反馈报告。

请使用 self-experience skill 执行自我体验流程。
```

---

## Checklist

- [ ] Discovered all available skills and features
- [ ] Designed diverse exploration plan (3-5 categories)
- [ ] Executed exploration scenarios
- [ ] Checked recent issues for cross-reference
- [ ] Generated structured feedback report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Test with developer-level knowledge — always assume zero prior knowledge
- Only test happy paths — edge cases reveal real issues
- Skip the send_user_feedback step — the report must be delivered
- Generate generic feedback — every observation must be specific and actionable
- Include sensitive information (user IDs, tokens, etc.) in the report
- Create issues or PRs directly — only report findings, let maintainers decide
