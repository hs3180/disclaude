---
name: self-experience
description: Self-experience (dogfooding) module - automatically explores own features from a new-user perspective, simulates diverse interactions, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "自测", "体验功能", "self-experience", "self-test", "模拟体验".
allowed-tools: Read, Glob, Grep, Bash, WebSearch
---

# Self-Experience (Dogfooding)

Simulate a real user exploring disclaude's features with random, unpredictable interactions.

## Core Principle

**Keep it simple, random, and divergent.**

Don't predefine detailed test scenarios or scoring rubrics. Instead, randomly pick something to try, interact naturally like a curious user, and report what you find.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## How It Works

### Step 1: Pick Something Random

Randomly choose ONE of the following to explore:

| Category | Examples |
|----------|----------|
| **Slash command** | `/feedback`, `/next-step`, `/schedule-recommend`, `/skill-creator` |
| **Skill** | `bbs-topic-initiator`, `daily-soul-question`, `site-miner` |
| **Feature** | Task management, schedule system, chat skill, MCP tools |
| **Workflow** | Create a scheduled task, send a card, start a discussion |
| **Edge case** | Empty input, very long input, special characters, rapid commands |

**Selection method**: Use the current date + a hash of recent chat history to deterministically pick a category, then randomly choose within it. The point is unpredictability — don't always test the same thing.

### Step 2: Act Like a Real User

Interact naturally. You are simulating one of these user types:

- **New user** — curious, exploring, doesn't know the right commands
- **Impatient user** — wants quick results, gives short commands
- **Confused user** — asks vague questions, makes typos

Write a **single natural message** as if you were that user. Examples:

- "帮我看看最近有什么有意思的讨论"
- "今天天气怎么样" (off-topic, to test graceful handling)
- "这个bot能干啥"
- "帮我创建一个定时任务每天早上提醒我喝水"
- "/feedback 你们这个搜索功能不太好使"

### Step 3: Observe and React

After sending the simulated message, observe the response:

- **What went well?** Note anything that worked smoothly
- **What was confusing?** Note unclear responses or missing guidance
- **What broke?** Note errors, failures, or unexpected behavior

Do NOT use a scoring rubric. Just note what stands out.

### Step 4: Report Findings

Generate a brief, honest report:

```markdown
## Dogfooding Report

**Date**: [Today]
**What I tried**: [The random feature/action]
**User persona**: [New/Impatient/Confused]

### What happened
[2-3 sentences describing the interaction]

### Observations
- [What worked]
- [What was confusing or broken]

### Issues Found
[If any bugs or UX problems were found, list them]
[Use `gh issue create` to file real issues for significant findings]

### Quick Takeaway
[One sentence summary]
```

### Step 5: Deliver Report

Send the report to the target chat:

```
send_user_feedback({
  chatId: "{chatId}",
  message: "{report}"
})
```

---

## Key Guidelines

### Do
- Pick features randomly — variety is the goal
- Be genuinely curious, like a real new user
- Keep interactions natural and brief
- Report honestly, including positive experiences
- File GitHub issues for real bugs found

### Don't
- Don't create elaborate test plans or scoring systems
- Don't test the same feature every time
- Don't spend more than a few minutes on each exploration
- Don't force findings — if nothing notable happened, say so
- Don't file issues for minor cosmetic preferences

---

## Example Sessions

### Example 1: Testing `/next-step`

**Persona**: New user
**Action**: Just finished a coding task, curious what to do next
**Simulated input**: "刚修完一个bug，接下来干啥"

### Example 2: Testing schedule feature

**Persona**: Impatient user
**Action**: Wants to set up a reminder quickly
**Simulated input**: "设个定时 每天早上9点提醒我 standup"

### Example 3: Testing edge case

**Persona**: Confused user
**Action**: Sends an empty or nonsensical message
**Simulated input**: "" (empty) or "asdfgh"

---

## Schedule Configuration

To enable daily dogfooding, create a schedule file:

```markdown
---
name: "每日随机测试"
cron: "0 11 * * 1-5"
enabled: true
blocking: true
chatId: "{your_chat_id}"
---

请使用 self-experience skill 进行每日随机测试。

要求：
1. 随机选择一个功能或交互方式来测试
2. 像真实用户一样自然互动
3. 记录观察结果
4. 如果发现 bug，提交 GitHub issue
5. 使用 send_user_feedback 发送简短报告
```

---

## Checklist

- [ ] Randomly selected a feature/action to test
- [ ] Adopted a natural user persona
- [ ] Interacted briefly and observed the result
- [ ] Noted what worked and what didn't
- [ ] Filed issues for real bugs (if any found)
- [ ] Sent brief report via send_user_feedback

---

## DO NOT

- Create detailed test plans or scoring matrices
- Test the same feature every session
- Spend excessive time on a single test
- File issues for trivial cosmetic preferences
- Over-analyze — keep it light and honest
