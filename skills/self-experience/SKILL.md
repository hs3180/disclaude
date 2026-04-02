---
name: self-experience
description: Automated post-deployment self-experience (dogfooding) specialist - detects recent changes, simulates user interactions, and generates structured feedback reports. Use when user says "自我体验", "dogfood", "体验测试", "自动反馈", "self-experience", or when triggered by scheduler after deployment.
allowed-tools: Read, Glob, Grep, Bash, WebSearch, send_user_feedback, Write
---

# Self-Experience (Dogfooding) Skill

Automatically detect recent changes, simulate human-like user interactions with the bot, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Post-deployment automated self-experience
- Dogfooding new features after they are merged
- Simulating user interactions to discover UX issues
- Generating structured feedback reports from simulated usage

**Keywords that trigger this skill**: "自我体验", "dogfood", "体验测试", "自动反馈", "self-experience", "post-deployment review"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Use LLM-based analysis and simulation, NOT pre-built test scripts.**

The LLM should:
1. Analyze recent changes to understand what was deployed
2. Design realistic test scenarios based on the changes
3. Simulate user interactions from a "new user" perspective
4. Generate structured feedback with actionable findings

---

## Self-Experience Process

### Phase 1: Change Detection

Detect what has recently changed in the codebase.

#### Step 1.1: Check Recent Git History

```bash
# Check commits from the last 7 days (or configurable period)
git log --since="7 days ago" --oneline --no-merges --format="%h %s (%ar)" | head -50
```

#### Step 1.2: Identify Changed Files

```bash
# List files changed in recent commits
git diff --name-only HEAD~20..HEAD 2>/dev/null || git log --since="7 days ago" --name-only --format="" | sort -u | head -100
```

#### Step 1.3: Detect Version Changes

```bash
# Check if version was bumped (package.json, etc.)
git log --since="7 days ago" -p -- package.json lerna.json 2>/dev/null | head -100

# Check current version
cat package.json 2>/dev/null | grep '"version"' || echo "No package.json found"
```

#### Step 1.4: Summarize Changes

Categorize the detected changes into:

| Category | Indicators | Example |
|----------|------------|---------|
| **New Feature** | New files, new skill directories | `skills/new-skill/SKILL.md` |
| **Bug Fix** | Fixes in existing code, test additions | Fix in `packages/core/src/` |
| **Refactor** | Large file moves, structure changes | Rename patterns in git log |
| **Config Change** | YAML, JSON config modifications | `disclaude.config.yaml` |
| **Documentation** | README, guide changes | `*.md` updates |

**Output**:
```markdown
## 📋 Change Detection Summary
- **Time range**: [date range analyzed]
- **Total commits**: [number]
- **Changed files**: [number]

### Categories:
- 🆕 New Features: [list]
- 🐛 Bug Fixes: [list]
- ♻️ Refactors: [list]
- ⚙️ Config Changes: [list]
```

---

### Phase 2: Scenario Design

Based on the detected changes, design realistic user interaction scenarios.

#### Step 2.1: Map Changes to Test Scenarios

For each change category, design scenarios:

**New Feature Scenarios**:
- 🎯 Primary path: Use the feature as intended
- 🔄 Alternative path: Try unusual but valid inputs
- ⚠️ Edge case: Boundary conditions, empty inputs, overload

**Bug Fix Scenarios**:
- ✅ Verify fix: Reproduce the original issue context, confirm it's resolved
- 🔁 Regression: Check related functionality isn't broken

**Refactor Scenarios**:
- 🔍 Smoke test: Verify basic functionality still works after refactor
- 📊 Compare: Check behavior matches before/after expectations

#### Step 2.2: Generate Persona Variations

Design scenarios from different user perspectives:

| Persona | Description | Test Focus |
|---------|-------------|------------|
| **New User** | First-time user, unfamiliar with the system | Onboarding, discoverability, clarity |
| **Power User** | Experienced user, uses advanced features | Efficiency, edge cases, performance |
| **Casual User** | Occasional user, simple requests | Basic functionality, error recovery |
| **Curious Explorer** | Likes to try everything | Feature combinations, unexpected inputs |

#### Step 2.3: Prioritize Scenarios

Prioritize based on:
1. **Impact**: How many users would be affected?
2. **Risk**: How likely is the change to break something?
3. **Novelty**: Is this a brand new feature (higher priority)?
4. **Complexity**: Does the change touch critical paths?

**Select 5-8 scenarios** for execution (don't try to do everything).

---

### Phase 3: Simulation Execution

Execute the designed scenarios by interacting with the system.

#### Step 3.1: Simulate Skill Interactions

For each skill that was recently changed or added:

1. **Read the SKILL.md** to understand its interface:
   ```bash
   cat skills/{skill-name}/SKILL.md
   ```

2. **Analyze the trigger conditions** and description quality:
   - Can a user easily discover when to use this skill?
   - Are the trigger keywords intuitive?
   - Is the description clear about what the skill does?

3. **Check skill integration**:
   - Are referenced tools available?
   - Are context variables properly documented?
   - Does the skill follow SKILL_SPEC.md conventions?

4. **Evaluate edge cases**:
   - What happens with missing context?
   - What happens with invalid inputs?
   - Are error messages helpful?

#### Step 3.2: Simulate Code Quality Checks

For code changes, perform lightweight analysis:

1. **Check for new test coverage**:
   ```bash
   # Find new test files
   git log --since="7 days ago" --name-only --format="" | grep -E "\.test\." | sort -u
   ```

2. **Check for TODO/FIXME additions** (new tech debt):
   ```bash
   git diff HEAD~20..HEAD | grep -E "^\+.*TODO|^\+.*FIXME|^\+.*HACK" | head -20
   ```

3. **Check for breaking changes**:
   ```bash
   # Look for API/interface changes
   git diff HEAD~20..HEAD | grep -E "^\-.*(export|interface|class|function|const)" | head -20
   ```

#### Step 3.3: Simulate User Experience Flows

For each priority scenario, simulate the user experience:

1. **Read relevant chat logs** to understand real user patterns:
   ```
   workspace/logs/
   ├── oc_chat1/
   │   └── 2026-04-01.md
   ```

2. **Analyze user interaction patterns**:
   - How do real users phrase their requests?
   - What kinds of errors do they encounter?
   - What features do they use most?

3. **Evaluate the UX of changes**:
   - Would a real user understand how to use this?
   - Are error messages helpful?
   - Is the workflow intuitive?

---

### Phase 4: Feedback Report Generation

Generate a structured feedback report from the simulation results.

#### Step 4.1: Structure the Report

```markdown
## 🐕 Self-Experience Report (Dogfooding)

**Version**: [current version]
**Date**: [execution date]
**Changes Analyzed**: [commit range or time range]
**Scenarios Tested**: [number] / [total designed]

---

### 📊 Executive Summary

[2-3 sentence overview of findings - what works well, what needs attention]

**Overall Health**: [🟢 Good / 🟡 Acceptable / 🔴 Needs Attention]

---

### 🆕 New Feature Experience

#### Feature 1: [Feature Name]

**Scenario**: [What was tested]
**Perspective**: [Which persona]

**Findings**:
- ✅ [What worked well]
- ⚠️ [What could be improved]
- ❌ [What didn't work / bugs found]

**Suggestions**:
- [Actionable improvement suggestion]

---

### 🐛 Bug Fix Verification

#### Fix 1: [Bug Description]

**Original Issue**: [What was broken]
**Verification**: [How it was tested]
**Result**: [✅ Confirmed fixed / ⚠️ Partially fixed / ❌ Not fixed]

---

### 🔍 Code Quality Observations

| Aspect | Status | Details |
|--------|--------|---------|
| Test Coverage | [✅/⚠️/❌] | [description] |
| Documentation | [✅/⚠️/❌] | [description] |
| Error Handling | [✅/⚠️/❌] | [description] |
| Breaking Changes | [✅/⚠️/❌] | [description] |

---

### 🎭 User Experience Assessment

| Dimension | Rating (1-5) | Notes |
|-----------|-------------|-------|
| Discoverability | [N] | Can users find and use new features? |
| Clarity | [N] | Are instructions and messages clear? |
| Error Recovery | [N] | Can users recover from errors easily? |
| Consistency | [N] | Is behavior consistent across features? |

---

### 📋 Action Items

#### High Priority
- [ ] [Action item 1] — [reason]

#### Medium Priority
- [ ] [Action item 2] — [reason]

#### Low Priority
- [ ] [Action item 3] — [reason]

---

### 💡 Highlights & Improvements

**What's working well**:
- [Positive finding 1]
- [Positive finding 2]

**Improvement ideas**:
- [Suggestion 1]
- [Suggestion 2]

---

*Report generated by self-experience skill | Execution time: [duration]*
```

#### Step 4.2: Save Report

Save the report to the workspace:

```bash
# Save to workspace with timestamp
write to: workspace/reports/self-experience-$(date +%Y-%m-%d).md
```

#### Step 4.3: Send Summary to User

**CRITICAL**: Always send a summary to the user using `send_user_feedback`.

Send the **Executive Summary** and **Action Items** sections via `send_user_feedback`:

```
send_user_feedback({
  content: [Summary section of the report in markdown format],
  format: "text",
  chatId: [The chatId from context]
})
```

---

### Phase 5: Issue Submission (Optional)

If critical bugs or significant issues are found during simulation, submit them as GitHub Issues.

#### Step 5.1: Evaluate Findings

Only submit issues for:
- 🔴 **Bugs**: Actual broken functionality discovered during simulation
- 🟡 **UX Issues**: Significant usability problems that would affect many users
- ❌ **DO NOT submit** for: minor suggestions, style preferences, or speculative concerns

#### Step 5.2: Submit Issue

For each critical finding:

```bash
gh issue create --repo hs3180/disclaude \
  --title "[Self-Experience] Brief description of the finding" \
  --body "## Self-Experience Finding

### Category
[bug / ux-issue / improvement]

### Scenario
[What was being tested when this was discovered]

### Expected Behavior
[What should happen]

### Actual Behavior
[What actually happened]

### Steps to Reproduce
1. [Step 1]
2. [Step 2]

### Environment
- Version: [current version]
- Found by: self-experience skill
- Date: $(date +%Y-%m-%d)" \
  --label "[bug or enhancement]"
```

---

## Schedule Configuration

To enable automated self-experience after deployments, create a schedule file:

```markdown
---
name: "自动体验反馈"
cron: "0 10 * * 1,4"  # Mon and Thu at 10 AM
enabled: true
blocking: true
chatId: "{your_team_chat_id}"
---

请使用 self-experience skill 执行自我体验流程：

1. 检测最近 7 天的代码变更
2. 根据变更设计 5-8 个模拟用户场景
3. 执行模拟并记录发现
4. 生成结构化反馈报告
5. 将报告摘要发送到当前 chatId
6. 如发现关键 bug，提交 GitHub Issue
```

---

## Execution Guidelines

### Scope Control
- **Default time range**: Last 7 days
- **Default scenarios**: 5-8 priority scenarios
- **Default personas**: 2-3 personas per scenario set
- **Don't try to be exhaustive** — focus on high-impact areas

### Quality Over Quantity
- It's better to deeply analyze 5 scenarios than shallowly test 20
- Each finding should have clear reproduction steps
- Each suggestion should be actionable

### Honest Assessment
- Report both positive findings AND problems
- Don't inflate findings to seem thorough
- Acknowledge limitations (e.g., "Cannot fully test MCP tools without live server")

---

## Checklist

- [ ] Detected recent changes via git history
- [ ] Categorized changes (features, fixes, refactors, etc.)
- [ ] Designed 5-8 test scenarios with persona variations
- [ ] Simulated interactions for each scenario
- [ ] Generated structured feedback report
- [ ] Saved report to workspace/reports/
- [ ] **Sent summary via send_user_feedback** (CRITICAL)
- [ ] Submitted GitHub Issues for critical findings (if any)

---

## DO NOT

- Run destructive tests (no actual deployments, no data deletion)
- Modify any code or configuration files during simulation
- Submit GitHub Issues for minor or speculative concerns
- Skip the send_user_feedback step
- Generate fabricated findings — only report what was actually observed
- Take longer than necessary — this is a lightweight simulation, not a full QA suite
