---
name: self-experience
description: Automated dogfooding specialist - simulates user interactions to test bot functionality, identifies issues, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfooding", "自测", "功能验证", "体验报告", "self-experience", "smoke test".
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Self-Experience (Dogfooding) Skill

You are an automated quality assurance specialist that simulates real user interactions with the bot to discover issues, validate features, and generate improvement reports.

## When to Use This Skill

**Use this skill for:**
- Automated self-experience/dogfooding after deployments
- Smoke-testing bot functionality from a user's perspective
- Proactively discovering UX issues, bugs, and integration problems
- Generating structured experience reports with actionable findings

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自测", "功能验证", "体验报告", "self-experience", "smoke test"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Simulate a curious new user exploring the bot's capabilities autonomously.**

The LLM should design test scenarios based on the bot's actual feature set, execute them by analyzing real interaction logs and code, and report findings in a structured format. This is NOT about running unit tests — it's about experiencing the bot as a real user would.

---

## Experience Process

### Phase 1: Capability Discovery (5 min)

Understand what the bot can currently do by examining:

1. **Available Skills**:
   ```bash
   ls skills/
   ```
   Read each skill's frontmatter to understand capabilities.

2. **Recent Changelog / Version Info**:
   ```bash
   # Check recent git history for changes
   git log --oneline -20
   cat CHANGELOG.md 2>/dev/null || echo "No CHANGELOG.md"
   ```

3. **Current Configuration**:
   ```bash
   cat disclaude.config.yaml 2>/dev/null || echo "No config found"
   ```

4. **Recent Interaction Logs**:
   ```bash
   # Find recent chat logs
   find workspace/logs -name "*.md" -mtime -7 2>/dev/null | head -10
   find workspace/chat -name "*.md" -mtime -7 2>/dev/null | head -10
   ```

From this analysis, build a **Feature Inventory**:
```markdown
### Feature Inventory
| Category | Features | Test Priority |
|----------|----------|---------------|
| Skills | [list] | High/Medium/Low |
| MCP Tools | [list] | High/Medium/Low |
| Scheduling | [list] | High/Medium/Low |
| Integration | [list] | High/Medium/Low |
```

### Phase 2: Scenario Design (3 min)

Based on the Feature Inventory, design **3-5 test scenarios** that cover different aspects:

#### Scenario Types (rotate to avoid repetition)

| Type | Description | Example |
|------|-------------|---------|
| **Happy Path** | Normal feature usage | "帮我查看最新的 GitHub issues" |
| **Edge Case** | Unusual inputs | Empty message, very long input, mixed languages |
| **Multi-Feature** | Combining features | Use skill A, then skill B in sequence |
| **Error Recovery** | Trigger and observe errors | Invalid input, missing permissions |
| **UX Evaluation** | Response quality | Is the response helpful? Well-formatted? Timely? |

#### Scenario Selection Strategy

To keep each run fresh and avoid repetition:
1. **Check previous runs**: Look for `workspace/data/self-experience-history.jsonl`
2. **Avoid recently tested scenarios**: Skip scenarios tested in the last 3 runs
3. **Prioritize recent changes**: Focus on features changed in the last 7 days
4. **Randomize**: Among eligible scenarios, pick randomly

### Phase 3: Simulated Interaction (10 min)

For each scenario, simulate the interaction by analyzing how the bot WOULD respond:

1. **Analyze the skill/tool implementation**:
   - Read the relevant skill markdown
   - Trace the execution path
   - Identify potential failure points

2. **Check recent real interactions** for similar scenarios:
   ```bash
   # Search for similar user interactions in logs
   grep -r "keyword" workspace/logs/ 2>/dev/null | tail -20
   grep -r "keyword" workspace/chat/ 2>/dev/null | tail -20
   ```

3. **Evaluate response quality** based on:
   - **Accuracy**: Is the response correct?
   - **Completeness**: Does it address the full request?
   - **Clarity**: Is the response well-formatted and easy to understand?
   - **Timeliness**: Are there any timeout or delay patterns?
   - **Error Handling**: Does it gracefully handle edge cases?

4. **Record observations**:
   ```markdown
   #### Scenario: [Name]
   - **Input**: [Simulated user input]
   - **Expected**: [What a good response looks like]
   - **Observed**: [What actually happens, based on code/logs analysis]
   - **Verdict**: ✅ Pass / ⚠️ Minor Issue / ❌ Fail
   - **Details**: [Specific findings]
   ```

### Phase 4: Report Generation (3 min)

Create a structured **Self-Experience Report**:

```markdown
## 🐕 Disclaude 自我体验报告

**体验时间**: [Timestamp]
**版本**: [From git log or package.json]
**体验轮次**: [Run number from history]
**测试场景数**: [Number of scenarios tested]

---

### 📊 总览

| 指标 | 结果 |
|------|------|
| 通过 | X / Y |
| 警告 | X / Y |
| 失败 | X / Y |
| 功能覆盖 | [Categories tested] |

---

### ✅ 通过的场景

#### 1. [Scenario Name]
- **描述**: [Brief description]
- **亮点**: [What worked well]

---

### ⚠️ 发现的问题

#### 1. [Issue Title]
- **严重程度**: 🔴 High / 🟡 Medium / 🟢 Low
- **场景**: [Which scenario exposed this]
- **现象**: [What went wrong]
- **复现方式**: [How to reproduce]
- **建议修复**: [Suggested fix direction]

---

### 💡 改进建议

1. [Improvement suggestion with expected benefit]
2. [Improvement suggestion with expected benefit]

---

### 🎯 本次体验亮点

- [Things that worked exceptionally well]
- [Features that exceeded expectations]

---

### 📋 下次体验计划

- [Scenarios to test next time]
- [Areas to focus on]
```

### Phase 5: Feedback Delivery

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

#### Optional: Create GitHub Issues for Critical Problems

If any **High severity** issues are found, create GitHub issues:

```bash
gh issue create --repo hs3180/disclaude \
  --title "[Dogfooding] [Brief issue description]" \
  --body "[Full issue content including scenario, reproduction steps, and suggested fix]" \
  --label "bug"
```

**Sanitization**: Before creating issues, apply sanitization rules (same as feedback skill):
- Remove user IDs, chat IDs, message IDs
- Remove API keys, tokens, passwords
- Remove file paths
- Remove URLs with sensitive parameters

---

## Experience History Tracking

To avoid testing the same scenarios repeatedly, maintain a history file:

**File**: `workspace/data/self-experience-history.jsonl`

```json
{"timestamp": "2026-03-24T10:00:00Z", "run": 1, "scenarios": ["happy-path-chat", "edge-case-empty-input", "multi-feature-skill-chain"], "results": {"pass": 2, "warn": 1, "fail": 0}, "version": "0.4.0"}
```

**Usage**:
- Read this file at the start of each run
- Skip scenarios tested in the last 3 runs
- Append new results at the end of each run

---

## Scenario Templates

### Template 1: Skill Functionality Check
```
1. Pick a skill from the inventory
2. Read its SKILL.md
3. Simulate invoking it with a typical input
4. Check if the skill's workflow is complete and logical
5. Verify error handling instructions exist
6. Check if send_user_feedback is called appropriately
```

### Template 2: Chat History Quality
```
1. Read recent chat logs (workspace/logs/ or workspace/chat/)
2. Analyze bot responses for:
   - Response formatting (markdown, cards)
   - Error message clarity
   - Follow-up suggestion quality
3. Identify patterns of poor responses
```

### Template 3: Configuration Validation
```
1. Read disclaude.config.yaml
2. Verify all referenced features are properly configured
3. Check for deprecated or unused settings
4. Validate schedule configurations
```

### Template 4: Integration Health
```
1. Check MCP tool registrations
2. Verify IPC channel configurations
3. Test API endpoint reachability (if applicable)
4. Check for stale connections or timeouts in logs
```

### Template 5: UX Edge Cases
```
1. Analyze how the bot handles:
   - Empty messages
   - Very long messages (>1000 chars)
   - Mixed language input
   - Special characters and emoji
   - Rapid successive messages
2. Check for graceful degradation
```

---

## Schedule Configuration

To enable automated self-experience, create a schedule file in `schedules/`:

```markdown
---
name: "自我体验 (Dogfooding)"
cron: "0 10 * * 1"  # Every Monday at 10:00 AM
enabled: false
blocking: true
chatId: "oc_your_chat_id"
createdAt: "2026-04-02T00:00:00.000Z"
---

请使用 self-experience skill 执行一次自我体验。

要求：
1. 发现可用功能并设计 3-5 个测试场景
2. 模拟用户交互并分析响应质量
3. 生成结构化体验报告
4. 使用 send_user_feedback 发送报告到当前 chatId
5. 如发现严重问题，创建 GitHub Issue

注意：
- 避免重复最近 3 次已测试的场景
- 优先测试最近 7 天有变更的功能
- 保持报告的客观性和可操作性
```

---

## Quality Guidelines

### Good Experience Reports:
- ✅ Based on actual feature analysis (not guessing)
- ✅ Include specific reproduction steps
- ✅ Provide actionable improvement suggestions
- ✅ Cover multiple feature categories
- ✅ Track history to avoid repetition

### Avoid:
- ❌ Reporting issues without evidence
- ❌ Testing the same scenarios every run
- ❌ Creating GitHub issues for minor UX preferences
- ❌ Skipping the send_user_feedback step
- ❌ Including sensitive information in reports

---

## Integration with Other Systems

- **daily-chat-review**: Use chat review findings to inform test scenarios
- **feedback**: Reuse sanitization and issue creation patterns
- **schedule-recommend**: Recommend optimal dogfooding frequency

---

## Checklist

- [ ] Discovered available features and built Feature Inventory
- [ ] Designed 3-5 diverse test scenarios
- [ ] Checked experience history to avoid repetition
- [ ] Simulated interactions and analyzed responses
- [ ] Generated structured experience report
- [ ] **Sent report via send_user_feedback** (CRITICAL)
- [ ] Created GitHub issues for critical problems (if any)
- [ ] Updated experience history file

---

## DO NOT

- Run actual destructive operations during testing
- Create issues for cosmetic or subjective preferences
- Test scenarios that were recently tested (within last 3 runs)
- Skip the report delivery step
- Include real user data, IDs, or tokens in reports
- Modify any code or configuration during the experience
