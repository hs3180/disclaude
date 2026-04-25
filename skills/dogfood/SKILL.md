---
name: dogfood
description: Self-testing dogfooding specialist - automatically explores and tests the bot's own features from a user perspective, generates structured experience reports. Use when user says keywords like "dogfood", "self-test", "自我体验", "自测", "dogfooding", "体验报告", "self-testing".
allowed-tools: Read, Glob, Grep, Bash, WebSearch
---

# Dogfood — Self-Testing Experience

Automatically explore and test the bot's own features from a user's perspective, generating structured experience reports with findings, issues, and improvement suggestions.

## When to Use This Skill

**Use this skill for:**
- Periodic self-testing of bot features and capabilities
- Generating structured dogfooding reports
- Discovering UX issues, bugs, and improvement opportunities
- Validating that recent changes work as expected from a user perspective

**Keywords that trigger this skill**: "dogfood", "self-test", "自我体验", "自测", "dogfooding", "体验报告", "self-testing", "自动体验"

## Core Principle

**Simulate a real user exploring features.**

The LLM should act as a curious new user who discovers and tries out features, rather than running scripted test cases. Focus on user experience, discoverability, and real-world usage patterns.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Exploration Process

### Step 1: Pick a Feature Area

Randomly select ONE feature area to explore from the categories below. Use the current date (day of week or date number) to deterministically pick — avoid always testing the same area.

| Category | Features to Explore | Test Approach |
|----------|-------------------|---------------|
| **Skill System** | Available skills, /commands, skill invocation | Try invoking 2-3 different skills, check response quality |
| **Chat & Conversation** | Multi-turn dialogue, context retention, session management | Ask follow-up questions, test topic switching |
| **Tool Usage** | MCP tools, file operations, web search | Request tasks that require tool chaining |
| **Scheduling** | Schedule creation, cron patterns, lifecycle | Review schedule configs, validate cron expressions |
| **Error Handling** | Edge cases, invalid inputs, boundary conditions | Send malformed requests, unusual queries |
| **Configuration** | Config loading, environment variables, defaults | Review config example, check fallback behavior |
| **Documentation** | README, CLAUDE.md, SKILL_SPEC accuracy | Verify docs match actual behavior |
| **Integration** | Feishu bot, MCP servers, external APIs | Test cross-feature workflows |

**Selection rule**: Cycle through categories sequentially or pick one you haven't tested recently. Check `workspace/dogfood/` for history.

### Step 2: Read Previous Reports (Avoid Duplication)

```bash
ls -la workspace/dogfood/*.md 2>/dev/null | tail -5
```

If previous reports exist, read the latest one:
```bash
cat workspace/dogfood/report-*.md 2>/dev/null | tail -100
```

**Skip rules**:
- If the same category was tested in the last 2 reports, pick a different one
- If a report was generated within the last 12 hours, skip entirely

### Step 3: Explore the Selected Feature

Act as a curious user and explore the selected feature area. This is the core of the dogfooding experience.

**Exploration guidelines**:
1. **Start with a natural question** — "What can you do?" or "Help me with X"
2. **Follow up based on responses** — Dig deeper into interesting capabilities
3. **Try edge cases** — Unusual inputs, boundary conditions
4. **Note friction points** — Things that are confusing, slow, or broken
5. **Check discoverability** — Can a new user find this feature easily?

**Concrete exploration actions** (pick 3-5 relevant ones):

```bash
# Explore available skills
ls skills/*/SKILL.md

# Check schedule configs
cat schedules/*.md

# Review recent changelog
head -100 CHANGELOG.md

# Check project configuration
cat disclaude.config.example.yaml | head -50

# Verify package structure
find packages -name "*.ts" | head -30

# Test CLI help
cat package.json | grep -A 20 '"scripts"'

# Check test coverage structure
ls tests/
```

### Step 4: Generate Experience Report

Create a structured report based on your exploration:

```markdown
# Dogfood Experience Report

**Date**: {date}
**Category**: {explored category}
**Tester**: disclaude (self-test)

## Summary

{1-2 sentence overview of what was explored and the overall impression}

## Exploration Log

### Test 1: {test description}
- **Action**: {what you tried}
- **Expected**: {what should happen}
- **Actual**: {what actually happened}
- **Verdict**: Pass / Issue / Suggestion

### Test 2: {test description}
- **Action**: {what you tried}
- **Expected**: {what should happen}
- **Actual**: {what actually happened}
- **Verdict**: Pass / Issue / Suggestion

## Findings

### Bugs / Issues
{List any bugs or issues found, with severity}

### UX Friction
{List any usability issues or confusing behavior}

### Improvement Suggestions
{List actionable improvement ideas}

### Highlights
{List things that worked well}

## Metrics

| Metric | Value |
|--------|-------|
| Features tested | {count} |
| Issues found | {count} |
| Suggestions | {count} |
| Overall health | Good / Fair / Needs attention |

## Next Steps

- [ ] {specific follow-up action if issues found}
- [ ] {suggestion for next exploration area}
```

### Step 5: Save and Report

1. **Save the report** to workspace:
   ```bash
   mkdir -p workspace/dogfood
   ```
   Write the report to `workspace/dogfood/report-{YYYY-MM-DD}-{category}.md`

2. **Send a summary** to the configured chatId via `send_user_feedback`:
   ```
   send_user_feedback({
     chatId: "{chatId}",
     message: "{summary of findings, formatted as a readable card}"
   })
   ```

**Summary format** (for chat message):
```markdown
## Dogfood Report ({date})

**Explored**: {category}

{Overall impression — 1-2 sentences}

**Findings**:
- {Finding 1}
- {Finding 2}
- {Finding 3}

{If issues found}: See full report in workspace/dogfood/
{If all good}: Everything looks healthy! Next area: {suggestion}
```

### Step 6: Create GitHub Issues (If Warranted)

If you discovered **actual bugs** (not just suggestions), create GitHub issues:

```bash
gh issue create --repo hs3180/disclaude \
  --title "bug: {short description}" \
  --body "{detailed description from report}" \
  --label "bug"
```

**Only create issues for**:
- Reproducible bugs or errors
- Missing functionality that blocks normal use
- Security concerns

**Do NOT create issues for**:
- Feature requests (mention in report only)
- Style or minor UX preferences
- Already-known issues

---

## Report Quality Guidelines

### Good Reports:
- Based on actual exploration, not speculation
- Include specific file paths and code references
- Provide actionable suggestions
- Honest about both good and bad findings
- Concise — focus on the most impactful findings

### Avoid:
- Vague observations without specifics
- Listing things that work as expected without testing
- Creating reports without actually exploring code
- Reports that only contain praise (critical thinking required)
- Duplicate findings from previous reports

---

## Example Scenario

### Input (Scheduled trigger):

Schedule triggers at configured time. No user input needed.

### Exploration (Error Handling category):

1. Checked how the bot handles empty messages
2. Tried sending extremely long messages (>10000 chars)
3. Tested concurrent command execution
4. Verified error messages are user-friendly

### Generated Report:

```markdown
# Dogfood Experience Report

**Date**: 2026-04-25
**Category**: Error Handling
**Tester**: disclaude (self-test)

## Summary

Explored error handling patterns across the codebase. Found that most error paths are well-covered, but some edge cases in message processing could benefit from better user-facing error messages.

## Exploration Log

### Test 1: Empty message handling
- **Action**: Checked bot.ts for empty message handling
- **Expected**: Graceful ignore or friendly prompt
- **Actual**: `handleMessageReceive()` checks `sender_type` and deduplicates, but no explicit empty message check
- **Verdict**: Suggestion — add explicit empty message guard

### Test 2: WebSocket reconnection
- **Action**: Reviewed WebSocket bot implementation
- **Expected**: Auto-reconnect with backoff
- **Actual**: Uses event-driven SDK with built-in reconnection
- **Verdict**: Pass

## Findings

### UX Friction
- Error messages in agent responses sometimes include raw error objects instead of user-friendly text

### Improvement Suggestions
- Add explicit empty message guard in `handleMessageReceive()`
- Consider centralized error formatting for agent errors

### Highlights
- Message deduplication via `processedMessageIds` is robust
- Bot self-check prevents infinite loops effectively

## Metrics

| Metric | Value |
|--------|-------|
| Features tested | 3 |
| Issues found | 0 |
| Suggestions | 2 |
| Overall health | Good |

## Next Steps

- [ ] Consider testing the Skill System category next
- [ ] Review error message formatting in chat-agent.ts
```

---

## Schedule Configuration

To enable automatic dogfooding, create a schedule file:

```markdown
---
name: "Dogfood Self-Test"
cron: "0 14 * * 1"  # Every Monday at 2:00 PM
enabled: false
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
createdAt: "2026-04-25T00:00:00.000Z"
---

请使用 dogfood skill 进行一次自我体验测试。

要求：
1. 从上次未测试的功能类别中选择一个
2. 以新用户视角探索该功能
3. 生成结构化的体验报告
4. 保存报告到 workspace/dogfood/
5. 使用 send_user_feedback 发送摘要到当前 chatId
6. 如果发现实际 bug，创建 GitHub Issue

注意：
- 避免与最近的报告重复测试同一类别
- 保持测试的随机性和拟人化
- 报告应诚实客观，既记录问题也记录亮点
```

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DOGFOOD_REPORT_DIR` | Directory for storing reports | `workspace/dogfood` |
| `DOGFOOD_MAX_HISTORY` | Max reports to keep | `20` |

### Cleanup

Old reports are automatically managed:
- Keep last 20 reports
- Older reports are archived or deleted during each run

---

## DO NOT

- Run destructive operations (delete files, modify configs, restart services)
- Create spam issues on GitHub
- Send multiple reports in the same execution
- Test the same category twice in a row
- Include sensitive information (API keys, user IDs) in reports
- Modify application code during testing (this is read-only exploration)
- Create new scheduled tasks during execution
