---
name: self-experience
description: Self-experience (dogfooding) module - automatically explores own features from a new-user perspective, simulates diverse interactions, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验".
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Self-Experience (Dogfooding)

Automatically explore disclaude's own features from a new-user perspective, simulate diverse interactions, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Self-testing disclaude's features after a new release or deployment
- Exploring available skills and their documentation quality
- Simulating new-user interactions to discover UX issues
- Generating structured feedback reports with improvement suggestions

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验", "体验一下"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Act as a curious new user exploring the product for the first time.**

Do not assume knowledge of internal architecture. Approach each feature as if discovering it for the first time. Focus on:
- Is it easy to understand what this does?
- Are the instructions clear and complete?
- What would confuse or frustrate a real user?
- What edge cases might cause unexpected behavior?

---

## Exploration Process

### Step 1: Inventory Available Features

Scan the skills directory to discover all available skills:

```bash
ls skills/
```

For each skill, read its SKILL.md to understand:
- What it claims to do (from `description` in frontmatter)
- How to invoke it (trigger keywords)
- What tools it requires
- Whether the documentation is complete and clear

### Step 2: Select Exploration Targets

**Selection rules**:
- Select 3-5 skills per exploration session
- Check `workspace/self-experience/history.json` for previously explored skills
- Prioritize skills NOT recently explored
- Include newly added or recently modified skills
- Aim for variety across skill categories

### Step 3: Explore Each Selected Skill

For each selected skill, perform these checks:

#### 3.1 Documentation Quality Check

Read the SKILL.md and evaluate:

| Criteria | What to Check |
|----------|---------------|
| **Clarity** | Is the purpose immediately clear from the first paragraph? |
| **Completeness** | Are all required steps documented? |
| **Examples** | Are there concrete input/output examples? |
| **Error handling** | Are error cases documented? |
| **DO NOT section** | Are anti-patterns explicitly listed? |

#### 3.2 Trigger Keyword Test

Verify that the `description` field in frontmatter contains appropriate trigger keywords:
- Are both Chinese and English keywords present?
- Are common synonyms covered?
- Would a new user naturally use these keywords?

#### 3.3 Workflow Validation

Trace through the documented workflow:
1. Does each step logically follow the previous one?
2. Are required tools listed in `allowed-tools`?
3. Are context variables properly documented?
4. Is the output format clear and unambiguous?
5. Does the checklist cover all critical steps?

#### 3.4 Edge Case Discovery

Consider scenarios the documentation doesn't cover:
- What happens with empty or malformed input?
- What if required tools are unavailable?
- What if the skill is invoked in the wrong context?
- What if multiple skills interact with each other?

### Step 4: Generate Feedback Report

Create a structured report for each explored skill:

```markdown
## 🧪 Self-Experience Report

**Date**: [ISO date]
**Session ID**: [unique ID from timestamp]
**Skills Explored**: [count] skills

---

### Skill: [skill-name]

**Overall Impression**: [1-2 sentence summary]

#### ✅ What Works Well
- [Specific positive findings]

#### ⚠️ Issues Found

| # | Severity | Issue | Details |
|---|----------|-------|---------|
| 1 | 🔴 High | [issue] | [details] |
| 2 | 🟡 Medium | [issue] | [details] |
| 3 | 🟢 Low | [issue] | [details] |

#### 💡 Improvement Suggestions
- [Specific, actionable suggestions]

---

### Summary

**Skills with issues**: [count]/[total]
**Critical issues**: [count]
**Improvement suggestions**: [count]

#### Top 3 Priorities
1. [Most impactful improvement]
2. [Second most impactful]
3. [Third most impactful]
```

### Step 5: Save and Send Report

1. **Save report** to `workspace/self-experience/reports/` directory:

```bash
mkdir -p workspace/self-experience/reports
```

Save as `workspace/self-experience/reports/YYYY-MM-DD.md`.

2. **Update exploration history** in `workspace/self-experience/history.json`:

```json
{
  "sessions": [
    {
      "date": "2026-05-18",
      "skillsExplored": ["skill-a", "skill-b"],
      "issuesFound": 3,
      "lastExplored": {
        "skill-a": "2026-05-18",
        "skill-b": "2026-05-18"
      }
    }
  ]
}
```

3. **Send report** to the user using `send_user_feedback`:

```
send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Severity Classification

| Level | Criteria | Example |
|-------|----------|---------|
| 🔴 **Critical** | Skill is unusable or produces incorrect results | Missing required steps, broken workflow |
| 🟡 **Medium** | Skill works but has notable UX issues | Unclear instructions, missing examples |
| 🟢 **Low** | Minor polish or enhancement opportunity | Better formatting, more trigger keywords |

---

## Quality Guidelines

### Good Self-Experience Reports:
- ✅ Based on actual reading of SKILL.md files
- ✅ Specific and actionable (not vague complaints)
- ✅ Considers new-user perspective
- ✅ Includes both positives and negatives
- ✅ Prioritizes findings by impact

### Avoid:
- ❌ Skimming without reading full documentation
- ❌ Reporting issues without suggesting fixes
- ❌ Being overly critical of minor formatting
- ❌ Assuming internal architecture knowledge
- ❌ Testing skills that require external dependencies you can't access

---

## Integration with Other Skills

| Skill | Relationship |
|-------|-------------|
| **feedback** | Use to file GitHub Issues for critical findings |
| **daily-chat-review** | Complementary — that reviews chat logs, this reviews feature docs |
| **skill-creator** | Can create improvements for skills with documentation issues |

---

## Checklist

- [ ] Listed all available skills from `skills/` directory
- [ ] Selected 3-5 skills for exploration
- [ ] Read each selected SKILL.md completely
- [ ] Evaluated documentation quality for each skill
- [ ] Checked trigger keywords (Chinese + English)
- [ ] Validated workflow completeness
- [ ] Considered edge cases
- [ ] Generated structured feedback report
- [ ] Saved report to `workspace/self-experience/reports/`
- [ ] Updated exploration history
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Actually invoke other skills during exploration (this is a documentation review, not a live test)
- Modify any SKILL.md files directly (use feedback skill to file issues instead)
- Include sensitive information in reports
- Skip reading the full SKILL.md before evaluating
- Generate reports longer than necessary — focus on actionable findings
