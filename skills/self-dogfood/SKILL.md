---
name: self-dogfood
description: Self-dogfooding skill - automatically experiences latest version features from a user perspective, runs diverse test scenarios, and generates structured feedback reports. Use when user says keywords like "自我体验", "dogfood", "自测", "体验报告", "版本体验", "self-dogfood".
allowed-tools: [Bash, Read, Glob, Grep, WebSearch, send_user_feedback]
---

# Self-Dogfood Skill

Automatically experience the latest version of disclaude from a user's perspective, run diverse anthropomorphic test scenarios, and generate structured feedback reports.

## When to Use This Skill

**Use this skill for:**
- Self-dogfooding after a new version release or deployment
- Running automated user-perspective tests
- Generating experience reports with findings and suggestions
- Discovering UX issues and integration problems

**Keywords that trigger this skill**: "自我体验", "dogfood", "自测", "体验报告", "版本体验", "self-dogfood", "version test", "experience report"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Simulate real user behavior, NOT scripted testing.**

The LLM should act as a curious new user exploring the system, not a QA engineer running test cases. Focus on discovering unexpected behaviors, UX friction, and integration issues through natural interaction patterns.

---

## Dogfooding Process

### Phase 1: Version Change Detection

**Objective**: Identify what changed since the last known version.

**Steps**:

1. **Get current version info**:
   ```bash
   # Check package.json for version
   cat package.json | grep '"version"'
   ```

2. **Get recent changes**:
   ```bash
   # Get changes since last tag (if tags exist)
   git tag --sort=-v:refname | head -1
   git log $(git tag --sort=-v:refname | head -1)..HEAD --oneline 2>/dev/null || \
     git log --oneline -20

   # Get changed files
   git diff --name-only $(git tag --sort=-v:refname | head -1)..HEAD 2>/dev/null || \
     git diff --name-only HEAD~20..HEAD
   ```

3. **Categorize changes**:
   - **Core changes**: Files in `packages/core/src/`
   - **Skill changes**: Files in `skills/`
   - **MCP changes**: Files in `packages/mcp-server/`
   - **Test changes**: Files in `tests/`
   - **Config changes**: Files like `*.json`, `*.yaml`, `*.md`

4. **Read changed skill files** to understand new/modified features:
   ```
   For each changed skill directory, read the SKILL.md to understand what changed.
   ```

---

### Phase 2: Scenario Generation

**Objective**: Generate diverse, unscripted test scenarios based on detected changes.

**Scenario Categories**:

| Category | Trigger | Example Scenarios |
|----------|---------|-------------------|
| **New Feature** | New skill or feature added | "Try the new X skill", "What can you do with X?" |
| **Modified Feature** | Existing skill modified | "Use X with edge case input", "Test X in unusual context" |
| **Integration** | Multiple components changed | "Combine X and Y", "Use X then immediately Y" |
| **Edge Case** | Any change | Empty input, very long input, special characters, mixed languages |
| **User Journey** | UX-focused | "I'm a new user, help me...", "What can you do?" |
| **Stress Test** | Performance-related | "Analyze this very large file", "Process 50 items" |

**Scenario Generation Rules**:

1. **Be creative and random**: Each run should produce different scenarios
2. **Cover multiple categories**: At least 3 different categories per run
3. **Prioritize changed areas**: Focus scenarios on recently changed components
4. **Include at least one edge case**: Always test boundary conditions
5. **Mix languages**: Include both Chinese and English interactions

**Generate 3-5 scenarios** per dogfooding session. Each scenario should include:
- **Persona**: Who is testing (new user, power user, confused user, etc.)
- **Action**: What they try to do
- **Expected outcome**: What a reasonable user would expect
- **Success criteria**: How to judge if the interaction was successful

---

### Phase 3: Experience Execution

**Objective**: Execute each scenario by actually interacting with the system.

**For each scenario**:

1. **Read relevant skill documentation**:
   ```
   Read the SKILL.md of the skill being tested to understand expected behavior.
   ```

2. **Simulate the interaction**:
   - Formulate the user message as the persona would
   - Analyze what the system would do (read code paths, check configurations)
   - Identify potential failure points

3. **Code-level verification**:
   ```bash
   # Check if relevant code paths exist and are correctly wired
   # Verify skill discovery works for new skills
   ls skills/  # List available skills
   grep -r "skill-name" packages/core/src/skills/  # Check skill registration

   # Verify configurations
   grep -r "config-key" packages/  # Check config usage

   # Check for common issues
   grep -r "TODO\|FIXME\|HACK\|XXX" packages/  # Check for tech debt
   ```

4. **Record observations**:
   - What worked well
   - What failed or was confusing
   - UX friction points
   - Missing error handling
   - Documentation gaps

---

### Phase 4: Report Generation

**Objective**: Generate a structured experience report.

**Report Template**:

```markdown
## Disclaude 自我体验报告 (Dogfooding Report)

**体验时间**: [ISO timestamp]
**版本**: [version from package.json]
**变更范围**: [summary of changes since last version]
**体验场景数**: [number of scenarios tested]

---

### 版本变更摘要

#### 新增功能
- [List new features detected]

#### 修改功能
- [List modified features]

#### 技术债务
- [Any TODO/FIXME/HACK found in changed files]

---

### 体验场景与结果

#### 场景 1: [Scenario Title]
- **角色**: [Persona]
- **操作**: [What was tried]
- **预期**: [Expected outcome]
- **结果**: [Actual outcome]
- **评分**: [1-5]
- **发现**:
  - [Issues found, if any]
  - [UX observations]

#### 场景 2: [Scenario Title]
...

---

### 综合评估

#### 亮点
- [Things that worked exceptionally well]

#### 问题发现
| 严重程度 | 问题描述 | 影响范围 | 建议修复方式 |
|----------|----------|----------|-------------|
| P0 (阻塞) | ... | ... | ... |
| P1 (严重) | ... | ... | ... |
| P2 (一般) | ... | ... | ... |
| P3 (建议) | ... | ... | ... |

#### UX 改进建议
1. [Improvement suggestion]
2. [Improvement suggestion]

#### 文档建议
1. [Documentation gap found]
2. [Documentation improvement needed]

---

### 下一步行动建议

- [ ] [Action item 1]
- [ ] [Action item 2]
- [ ] [Action item 3]

---

*本报告由 self-dogfood skill 自动生成*
*体验版本: [version] | 生成时间: [timestamp]*
```

---

### Phase 5: Report Delivery

**CRITICAL**: Always send the report using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

**Optional: Submit as GitHub Issue**

If P0 or P1 issues are found, also submit a GitHub issue:

```bash
gh issue create --repo hs3180/disclaude \
  --title "[Dogfood] [Version X.X.X] Issues found in self-dogfooding" \
  --body "[Sanitized report]" \
  --label "enhancement"
```

**Sanitization rules** (same as feedback skill):
- Replace user IDs, chat IDs, message IDs
- Replace file paths with `[FILE]`
- Replace URLs with `[URL]`
- Never include API keys or tokens

---

## Schedule Configuration

To enable automatic dogfooding after deployments, create a schedule:

```markdown
---
name: "Self-Dogfood"
cron: "0 10 * * 1,3,5"  # 10am on Mon, Wed, Fri
enabled: true
blocking: true
chatId: "{target_chat_id}"
---

请使用 self-dogfood skill 执行一次自我体验。

要求：
1. 检测自上次运行以来的代码变更
2. 生成 3-5 个多样化的测试场景
3. 执行体验并记录结果
4. 生成结构化报告
5. 使用 send_user_feedback 发送报告

注意：
- 每次运行应生成不同的场景
- 优先测试最近变更的功能
- 如果发现 P0/P1 问题，同时提交 GitHub Issue
```

---

## Scenario Inspiration Bank

When generating scenarios, draw inspiration from these patterns:

### New User Onboarding
- "What can you do?" (feature discovery)
- "Help me with..." (vague request)
- Send an empty message
- Send only an emoji

### Power User
- Chain multiple skills in sequence
- Use advanced features with complex inputs
- Test skill combinations that might conflict

### Edge Cases
- Very long message (> 4000 chars)
- Message with only special characters
- Mixed Chinese/English/Japanese
- Message with code blocks, JSON, or markdown
- Request that requires file access

### Error Recovery
- Send invalid input and see error handling
- Interrupt an ongoing task
- Request something outside the system's capabilities

### Real-world Scenarios
- "Summarize the latest PR discussion"
- "What issues need attention?"
- "Help me understand this error: [paste error]"
- "Create a schedule for daily review"

---

## Checklist

- [ ] Detected version and recent changes
- [ ] Categorized changes by component area
- [ ] Generated 3-5 diverse test scenarios
- [ ] Read relevant skill documentation
- [ ] Executed code-level verification for each scenario
- [ ] Recorded observations for each scenario
- [ ] Generated structured report with ratings
- [ ] Identified P0-P3 issues (if any)
- [ ] Provided UX improvement suggestions
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Run actual destructive operations (delete files, send messages to real users)
- Create scheduled tasks from within this skill
- Include sensitive information in reports
- Use the same scenarios every time (be creative and random)
- Skip the send_user_feedback step
- Submit trivial issues to GitHub (only P0/P1)
- Run for more than 10 minutes per session
