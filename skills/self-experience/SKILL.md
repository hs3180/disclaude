---
name: self-experience
description: Self-experience (dogfooding) module - automatically explores own features from a new-user perspective, simulates diverse interactions, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验".
allowed-tools: Read, Glob, Grep, Bash, WebSearch, send_user_feedback
---

# Self-Experience (Dogfooding)

Automatically explore own features from a new-user perspective, simulate diverse interactions, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Running self-experience sessions to test own capabilities
- Simulating new-user interactions without preset scenarios
- Generating structured feedback reports with improvement suggestions
- Verifying feature completeness after version updates

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验", "体验新版"

## Core Principle

**Explore freely as a curious new user, not as a developer running test cases.**

The goal is to discover real UX issues that preset tests miss. Be creative, unpredictable, and genuinely curious. Do not follow a rigid checklist — let your exploration flow naturally based on what you discover.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Exploration Process

### Step 1: Inventory Available Features

Discover what the system can do:

1. **List all available skills**:
```bash
ls -la .claude/skills/ 2>/dev/null || echo "No workspace skills found"
ls -la skills/ 2>/dev/null || echo "No package skills found"
```

2. **Read each skill's description** from SKILL.md frontmatter:
```bash
# Extract name and description from each skill
for skill_dir in .claude/skills/*/; do
  echo "=== $(basename $skill_dir) ==="
  head -5 "$skill_dir/SKILL.md" 2>/dev/null
done
```

3. **Check available tools and commands**: Identify MCP tools, slash commands, and interactive capabilities.

4. **Review recent changes** (if git available):
```bash
git log --oneline -20 2>/dev/null
```

### Step 2: Simulate Diverse User Personas

For each exploration round, adopt a different user persona and interact naturally:

| Persona | Behavior | Example Interactions |
|---------|----------|----------------------|
| **Curious Newbie** | Asks basic questions, explores every feature | "你能做什么？", "帮我试试这个功能" |
| **Power User** | Tries advanced combinations, edge cases | Combines multiple skills, chains operations |
| **Frustrated User** | Uses vague/imprecise language | "帮我弄一下那个东西", "不好使了" |
| **Multilingual User** | Mixes languages, uses slang | "Can you help me 做 个 test?" |
| **Non-technical User** | Uses everyday language, no jargon | "我想弄个投票", "能不能帮我看看" |

**Persona Selection**: Pick 2-3 personas randomly per session. Do NOT use all personas every time.

### Step 3: Execute Exploration Scenarios

For each selected persona, perform 3-5 natural interactions. Choose from these scenario categories:

#### Category A: Feature Discovery
- Ask "what can you do?" and explore the response
- Try triggering different skills via their keywords
- Test slash commands if available

#### Category B: Skill Invocation
- Invoke a random skill with realistic user input
- Test a skill with incomplete or ambiguous arguments
- Try invoking a skill that might not exist

#### Category C: Edge Cases
- Send extremely long messages (> 1000 chars)
- Send very short messages (single character)
- Use special characters, emoji-only, or empty-feeling input
- Mix multiple languages in one message

#### Category D: Workflow Simulation
- Simulate a realistic multi-step user task
- Try combining 2-3 skills in sequence
- Test error recovery: deliberately provide invalid input, then correct it

#### Category E: Fuzzy Requests
- Make vague requests without specific instructions
- Ask open-ended questions
- Request something slightly outside the system's expected scope

**IMPORTANT**: Do NOT execute all categories every session. Pick 2-3 categories that feel natural for the selected personas.

### Step 4: Record Observations

For each interaction, record:

```markdown
### Interaction: [N] — [Persona] — [Category]

**Input**: What the simulated user said/did
**Expected**: What a reasonable user would expect to happen
**Actual**: What actually happened (or would happen based on code analysis)
**Verdict**: ✅ Good / ⚠️ Could Improve / ❌ Problem
**Notes**: Any specific observations
```

**How to evaluate**: Since you are analyzing the system rather than running a live instance:
1. Read the skill's SKILL.md to understand its intended behavior
2. Trace the logic: does the skill handle this input correctly?
3. Check error handling: what happens with edge cases?
4. Evaluate UX: is the response helpful and natural?

### Step 5: Generate Feedback Report

Compile all observations into a structured report:

```markdown
# 🐶 Self-Experience Report

**Date**: [Date]
**Duration**: [Session duration estimate]
**Personas Used**: [List]
**Scenarios Tested**: [Count]

---

## Summary

| Metric | Count |
|--------|-------|
| ✅ Good experiences | N |
| ⚠️ Improvement opportunities | N |
| ❌ Problems found | N |
| 📋 Total interactions | N |

---

## Highlights (What Works Well)

### 1. [Feature/Behavior]
- **Persona**: [Which persona discovered this]
- **Observation**: [What happened]
- **Why it's good**: [Why this is a positive UX]

---

## Improvement Opportunities

### 1. [Issue Title]
- **Severity**: Low / Medium / High
- **Category**: UX / Error Handling / Feature Gap / Documentation
- **Reproduction**: [How to trigger]
- **Expected**: [What should happen]
- **Actual**: [What happens instead]
- **Suggestion**: [How to improve]

---

## Problems Found

### 1. [Bug/Issue Title]
- **Severity**: High
- **Category**: Bug / Security / Data Loss
- **Details**: [Description]
- **Steps to Reproduce**: [Numbered steps]
- **Impact**: [User impact]

---

## Recommendations

| Priority | Action | Effort |
|----------|--------|--------|
| 🔴 High | [Action] | S/M/L |
| 🟡 Medium | [Action] | S/M/L |
| 🟢 Low | [Action] | S/M/L |

---

*Report generated by self-experience skill | Dogfooding session*
```

### Step 6: Send Report

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- chatId: [The chatId from context]
- format: "text"
- content: [The report in markdown format]
```

---

## Quality Guidelines

### Good Self-Experience Sessions:
- ✅ Discover real issues that users would encounter
- ✅ Cover diverse interaction patterns
- ✅ Focus on UX quality, not just functional correctness
- ✅ Provide actionable improvement suggestions
- ✅ Balance positive findings with areas for improvement
- ✅ Feel natural, not robotic or scripted

### Avoid:
- ❌ Only testing happy-path scenarios
- ❌ Running through a fixed checklist every time
- ❌ Being too gentle — honest feedback is more valuable
- ❌ Reporting only bugs without UX observations
- ❌ Generating generic feedback that applies to any product
- ❌ Spending more than 15 minutes on analysis per session

---

## Schedule Configuration

To enable periodic self-experience sessions:

```markdown
---
name: "自我体验"
cron: "0 16 * * 5"  # Every Friday at 4:00 PM
enabled: true
blocking: true
chatId: "{your_chat_id}"
---

请使用 self-experience skill 进行一次自我体验 session。

要求：
1. 随机选择 2-3 个用户角色
2. 探索不同的功能组合
3. 生成结构化反馈报告
4. 使用 send_user_feedback 发送报告
```

---

## Exploration Inspiration

When unsure what to explore, pick from these ideas:

1. **Skill chain**: Try using 2-3 skills in sequence (e.g., create topic → get feedback → generate report)
2. **Error recovery**: Send invalid input, then correct it — does the system recover gracefully?
3. **Help quality**: Ask "how do I..." for various features — are the responses helpful?
4. **Language mixing**: Use Chinese, English, or mixed input — does the system handle all smoothly?
5. **Feature gaps**: Try something the system "almost" supports — is the error message helpful?
6. **Output format**: Request output in different formats (table, list, card) — does it comply?
7. **Context memory**: Reference something from earlier in the conversation — does the system remember?

---

## Checklist

- [ ] Listed all available skills and features
- [ ] Selected 2-3 diverse user personas
- [ ] Performed 3-5 natural interactions per persona
- [ ] Recorded observations for each interaction
- [ ] Generated structured feedback report
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Run automated test suites (this is UX exploration, not QA testing)
- Modify system configuration during exploration
- Send real messages to external users/groups
- Access sensitive user data during simulation
- Spend excessive time on a single scenario (max 3 min each)
- Generate reports longer than 2000 words
- Skip the send_user_feedback step
