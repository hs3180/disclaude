---
name: self-experience
description: Self-experience (dogfooding) skill - automatically tests disclaude features by acting as a new user, evaluates outputs, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfood", "自我测试", "功能体验", "自动测试", "self-experience", "dogfooding".
allowed-tools: Read, Glob, Grep, Bash, Write
---

# Self-Experience (Dogfooding) Skill

Automatically test disclaude's own capabilities by simulating a new user experience, then generate a structured feedback report.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

---

## Core Principle

**Act as a curious new user exploring disclaude for the first time.**

Do NOT follow rigid test scripts. Instead, let curiosity guide exploration:
- Try features that seem interesting
- Ask questions a real user might ask
- Push boundaries with edge cases
- Combine features in unexpected ways

---

## Execution Steps

### Step 1: Discover Available Features

Read the current capabilities to understand what to test:

```bash
# Check current version
cat package.json | grep '"version"'

# Read CLAUDE.md for feature overview
cat CLAUDE.md

# List available skills
ls skills/
```

Also check recent changes to focus on new/modified features:

```bash
# Check recent git log for new features
git log --oneline -20

# Read CHANGELOG.md for recent changes
head -100 CHANGELOG.md
```

### Step 2: Generate Test Scenarios

Based on discovered features, generate **3-5 diverse test scenarios**. Scenarios should cover different categories:

| Category | Example Scenarios |
|----------|-------------------|
| **Core Chat** | "帮我总结一下最近的工作进展", "解释一下什么是 MCP" |
| **Skill Usage** | Try invoking available skills with realistic prompts |
| **Edge Cases** | Empty message, very long input, mixed language, ambiguous requests |
| **Feature Combos** | Use multiple features together (e.g., search + analyze + report) |
| **Error Recovery** | Invalid inputs, impossible requests, conflicting instructions |

**Important**: Do NOT always test the same scenarios. Vary them based on:
- Recent changes (prioritize testing new features)
- Previous failures (retry scenarios that failed before)
- Time-based rotation (different categories on different days)

### Step 3: Execute Test Scenarios

For each scenario, execute via CLI mode and capture the result:

```bash
disclaude --prompt "<test scenario>" 2>&1
```

**Capture**:
- The prompt sent
- The full response received
- Any errors or warnings
- Response time (approximate)
- Whether the response was helpful

**Timeout**: If a scenario takes more than 60 seconds, note it as a timeout and move on.

### Step 4: Evaluate Results

For each executed scenario, evaluate:

1. **Response Quality** (1-5):
   - Did it understand the intent?
   - Was the response accurate?
   - Was the response helpful?
   - Was the response well-formatted?

2. **Error Detection**:
   - Crashes or unhandled exceptions
   - Incorrect or misleading information
   - Missing functionality
   - Performance issues (slow response, high memory)

3. **UX Assessment**:
   - Would a real user understand the response?
   - Is the tone appropriate?
   - Are there unnecessary technical jargons?

### Step 5: Generate Report

Create a structured feedback report in markdown:

```markdown
## 🐕 Disclaude 自我体验报告

**体验时间**: [ISO 8601 timestamp]
**版本**: [version from package.json]
**体验场景数**: [number]
**总体评分**: [1-5]

---

### 📊 评分概览

| 场景 | 类别 | 评分 | 状态 |
|------|------|------|------|
| [scenario 1] | [category] | [1-5] | ✅/⚠️/❌ |
| [scenario 2] | [category] | [1-5] | ✅/⚠️/❌ |
| ... | ... | ... | ... |

---

### ✅ 体验亮点

- [Things that worked well]

### ⚠️ 发现的问题

#### 问题 1: [Title]
- **场景**: [Which scenario triggered it]
- **表现**: [What went wrong]
- **严重程度**: 🔴 High / 🟡 Medium / 🟢 Low
- **复现步骤**: [Steps to reproduce]
- **建议修复**: [Suggested fix]

### 💡 改进建议

- [Suggestions for improvement]

### 📋 下次体验重点

- [What to focus on next time]
```

### Step 6: Save Report

Save the report to `workspace/dogfood/` directory:

```bash
# Create directory if needed
mkdir -p workspace/dogfood/

# Save report with timestamp
REPORT_FILE="workspace/dogfood/$(date +%Y-%m-%d).md"
```

Write the report to the file using the Write tool.

Also update the version tracking file:

```bash
# Track last tested version
echo "{\"lastVersion\": \"<current_version>\", \"lastRun\": \"<timestamp>\", \"lastScore\": <score>}" > workspace/dogfood/state.json
```

### Step 7: Send Report (if chatId available)

If a chatId is available (from context), send a summary via send_user_feedback:

```
Use send_user_feedback with:
- content: [Report summary - first 500 chars + link to full report]
- format: "text"
- chatId: [from context]
```

---

## Scenario Generation Guidelines

### What Makes a Good Scenario

1. **Realistic**: A real user would actually do this
2. **Diverse**: Covers different features and capabilities
3. **Challenging**: Not trivially easy, tests real functionality
4. **Safe**: Won't cause data loss or security issues

### Scenario Anti-Patterns

- ❌ Always testing the same "hello world" scenario
- ❌ Only testing happy paths
- ❌ Testing things that require external accounts/services
- ❌ Scenarios that could delete or modify important data

### Example Scenarios by Category

**Core Chat**:
- "帮我查一下今天的天气" (tests if it properly handles location-dependent queries)
- "用简单的语言解释量子计算" (tests knowledge and explanation ability)
- "写一首关于编程的俳句" (tests creativity)

**Skill Discovery**:
- "你有哪些技能？" (tests skill listing)
- "帮我分析一下这个仓库的代码结构" (tests code analysis)
- "创建一个临时会话来讨论部署方案" (tests chat creation)

**Edge Cases**:
- Send an empty message or whitespace only
- Very long prompt (>1000 characters)
- Mix Chinese and English in the same request
- Ask something impossible ("帮我飞到月球")

---

## Version Change Detection

The skill uses `workspace/dogfood/state.json` to track the last tested version:

1. Read current version from `package.json`
2. Compare with `state.json` lastVersion
3. If versions differ, prioritize testing new features from CHANGELOG
4. If versions are the same, still run but can focus on different scenarios

---

## State File Format

`workspace/dogfood/state.json`:

```json
{
  "lastVersion": "0.5.0",
  "lastRun": "2026-04-23T08:00:00Z",
  "lastScore": 4,
  "totalRuns": 5,
  "averageScore": 3.8
}
```

---

## Checklist

- [ ] Discovered available features (skills, commands, recent changes)
- [ ] Generated 3-5 diverse test scenarios
- [ ] Executed each scenario via `disclaude --prompt`
- [ ] Evaluated response quality for each scenario
- [ ] Generated structured report
- [ ] Saved report to `workspace/dogfood/`
- [ ] Updated state file with version and score
- [ ] Sent summary to chatId (if available)

---

## DO NOT

- ❌ Test destructive operations (deleting files, dropping databases)
- ❌ Test with real user data or credentials
- ❌ Always use the same test scenarios
- ❌ Skip the report generation step
- ❌ Modify any source code files during testing
- ❌ Create new schedules (schedule execution rule)
- ❌ Test features that require paid external services
