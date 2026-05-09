---
name: self-experience
description: Self-experience (dogfooding) module - automatically explores own features from a new-user perspective, simulates diverse interactions, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验". Triggered by scheduler for automated execution after deployment.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, send_user_feedback
---

# Self-Experience (Dogfooding)

Automatically explore disclaude's own features from a new-user perspective, simulate diverse interactions, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Automated self-testing after deployment or version update
- Exploring features from a new-user perspective
- Generating structured feedback and improvement reports
- Discovering UX issues through simulated interactions

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Explore as a curious new user, not as a developer.** Discover issues through natural interaction patterns, not scripted test cases.

---

## Execution Process

### Step 1: Feature Discovery

Scan the codebase to understand what features are currently available.

**Actions:**
1. Read available skills: `Glob skills/*/SKILL.md`
2. Read the project README or CLAUDE.md for feature overview
3. Check installed tools and capabilities
4. List all slash commands (`/` prefixed skills)

Output a feature inventory:

```
📋 Feature Inventory:
- Skills: [count] available
- Key capabilities: [list top 5-8 features]
- New or recently changed features: [from CHANGELOG.md]
```

### Step 2: Generate Exploration Scenarios

Based on the feature inventory, create **3-5 diverse exploration scenarios** that cover different user personas and interaction patterns. Do NOT use preset test cases — generate scenarios dynamically based on what's available.

**Scenario diversity guidelines:**

| Dimension | Variety |
|-----------|---------|
| User persona | First-time user, power user, non-technical user |
| Input style | Short command, long description, vague request, mixed language |
| Feature area | Chat, scheduling, skills, integrations, file management |
| Edge case | Empty input, very long input, special characters, rapid commands |

**Example scenario generation:**

```
🎭 Scenario 1 (First-time user):
   A new user who doesn't know any slash commands tries to get help.
   They ask: "你能做什么？" (What can you do?)

🎭 Scenario 2 (Power user):
   An experienced user tries to chain multiple operations.
   They ask: "帮我分析最近的聊天记录然后生成改进建议"

🎭 Scenario 3 (Edge case — mixed language):
   User sends a message mixing Chinese, English, and emoji.
   They ask: "帮我schedule一个daily review的task 📅"
```

### Step 3: Simulate Interactions

For each scenario, simulate the user interaction and evaluate the response quality.

**For each scenario, evaluate:**

1. **Response Quality** — Is the response helpful and accurate?
2. **Error Handling** — What happens with unexpected input?
3. **Latency Perception** — Does the response feel responsive?
4. **Discoverability** — Can a new user find and use this feature easily?
5. **Documentation** — Is the help text clear and complete?

**Simulation method:**

For each scenario, imagine being that user and trace through what would happen:

```
📝 Simulating: "你能做什么？"

Expected behavior:
- Agent should list available capabilities
- Should mention key slash commands
- Should be welcoming to new users

Issues found:
- [Any gaps or problems discovered]
```

**IMPORTANT**: Do NOT actually execute commands or make changes. This is an analytical simulation — evaluate based on reading skill definitions, code, and documentation.

### Step 4: Analyze Real Interaction History (if available)

Check if there's recent chat history to learn from real user interactions:

```bash
# Check for recent chat logs
ls -la workspace/logs/ 2>/dev/null | tail -20
# Or check chat history files
ls -la workspace/chat/ 2>/dev/null | tail -20
```

If available, read recent logs to:
- Identify real user pain points
- Find features that confuse users
- Discover common error patterns
- Note feature requests that appear repeatedly

### Step 5: Generate Feedback Report

Create a structured report with the following sections:

```markdown
## 🐕 Self-Experience Report (Dogfooding)

**Date**: [ISO timestamp]
**Version**: [from package.json]
**Scenarios tested**: [count]
**Issues found**: [count]

---

### 📊 Feature Inventory

| Category | Count | Status |
|----------|-------|--------|
| Skills | X | ✅ All loaded |
| Slash commands | X | ✅ Available |
| Scheduled tasks | X | ✅/⚠️/❌ |

---

### 🎭 Exploration Results

#### Scenario 1: [Title]
- **Persona**: [User type]
- **Input**: [Simulated input]
- **Expected**: [What should happen]
- **Actual**: [What would happen based on code analysis]
- **Rating**: ⭐⭐⭐⭐⭐ (1-5)
- **Issues**: [Any problems found]

[... repeat for each scenario ...]

---

### 🔴 Critical Issues (Must Fix)

1. **[Issue Title]**
   - Impact: [Who is affected]
   - Reproduction: [How to trigger]
   - Suggested fix: [Brief description]

---

### 🟡 UX Improvements (Should Fix)

1. **[Issue Title]**
   - Current behavior: [What happens now]
   - Expected behavior: [What should happen]
   - Effort: [Low/Medium/High]

---

### 🟢 Highlights (Working Well)

- [Features that work smoothly]
- [Good UX patterns found]
- [Features users would enjoy]

---

### 💡 Feature Suggestions

1. **[Suggestion]** — [Brief rationale]

---

### 📋 Recommended Actions

| Priority | Action | Issue |
|----------|--------|-------|
| 🔴 High | [Action 1] | [Issue link or description] |
| 🟡 Medium | [Action 2] | [Issue link or description] |
| 🟢 Low | [Action 3] | [Issue link or description] |
```

### Step 6: Save and Send Report

1. **Save the report** to `workspace/self-experience-reports/`:
   ```
   workspace/self-experience-reports/YYYY-MM-DD.md
   ```

2. **Send the report** using `send_user_feedback`:
   ```
   Use send_user_feedback with:
   - content: [The report in markdown format]
   - format: "text"
   - chatId: [The chatId from context]
   ```

3. **If critical issues found**, suggest creating GitHub issues:
   ```bash
   gh issue create --repo hs3180/disclaude \
     --title "[Brief description]" \
     --body "[Full issue content]" \
     --label "bug"
   ```

---

## Simulation Guidelines

### How to Evaluate

| Aspect | Good (⭐⭐⭐⭐⭐) | Needs Work (⭐⭐) |
|--------|-----------|------------|
| **Response quality** | Accurate, helpful, concise | Vague, incorrect, or overly verbose |
| **Error handling** | Graceful recovery, helpful message | Silent failure or confusing error |
| **Discoverability** | Easy to find and use | Requires documentation to discover |
| **Edge cases** | Handles gracefully | Breaks or produces wrong output |
| **Documentation** | Clear and complete | Missing, outdated, or confusing |

### What to Focus On

1. **New-user experience** — Can someone use this without reading docs?
2. **Error recovery** — What happens when things go wrong?
3. **Feature gaps** — What's missing that users would expect?
4. **Consistency** — Do similar features behave similarly?
5. **Performance** — Are there obvious bottlenecks?

### What to Ignore

- Issues already tracked in open GitHub issues
- Known limitations documented in README
- Platform-specific issues (Mac, Windows) unless testing on that platform
- Performance issues that only appear with extreme load

---

## DO NOT

- Actually execute destructive commands (delete files, send messages to real users)
- Create real GitHub issues without user confirmation
- Modify configuration or code during simulation
- Send messages to chats other than the invoking chatId
- Run real scheduled tasks or triggers
- Skip the report generation step

## Checklist

- [ ] Discovered available features via codebase scan
- [ ] Generated 3-5 diverse exploration scenarios
- [ ] Simulated each scenario and evaluated quality
- [ ] Checked real interaction history (if available)
- [ ] Generated structured feedback report
- [ ] Saved report to workspace/self-experience-reports/
- [ ] Sent report via send_user_feedback

## Related Skills

- `/feedback` — Submit specific issues found during testing
- `/schedule` — Set up periodic self-experience runs
- `/daily-chat-review` — Complementary analysis of real user interactions
