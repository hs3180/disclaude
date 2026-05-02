---
name: self-experience
description: Self-experience (dogfooding) specialist - simulates a new user's perspective to evaluate the system's own features, generates structured self-review reports with improvement suggestions. Use when user says keywords like "自我体验", "dogfooding", "自检", "self-review", "体验报告", "self-experience".
allowed-tools: Read, Glob, Grep, Bash, send_user_feedback
---

# Self-Experience (Dogfooding)

Simulate a new user's perspective to experience and evaluate the system's own features, generating structured self-review reports with actionable improvement suggestions.

## When to Use This Skill

**Use this skill for:**
- Automated self-experience (dogfooding) after version updates
- Simulating new user perspective to discover UX issues
- Generating structured self-review reports
- Identifying usability problems that automated tests cannot catch
- Proactively discovering improvement opportunities

**Keywords that trigger this skill**: "自我体验", "dogfooding", "自检", "self-review", "体验报告", "self-experience", "自我体检"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Experience the system as a curious new user, NOT as a developer.**

The goal is to discover what a real user would encounter: confusing responses, missing features, poor error messages, and unexpected behaviors. Approach everything with fresh eyes.

---

## Self-Experience Process

### Step 1: Gather System Context

Collect information about the current system state:

1. **Identify available Skills**:
   ```bash
   ls skills/
   ```
   List all available skills to understand the system's capability surface.

2. **Check recent changes** (if git is available):
   ```bash
   git log --oneline -20
   ```
   Understand what has recently changed or been added.

3. **Read system configuration** (non-sensitive):
   ```bash
   cat config.yaml 2>/dev/null || cat config.json 2>/dev/null || echo "No config found"
   ```

### Step 2: Analyze Recent Interactions

Read recent chat logs to understand real-world usage patterns:

1. **Find recent chat logs**:
   ```bash
   # Check both possible log locations
   ls workspace/logs/ 2>/dev/null
   ls workspace/chat/ 2>/dev/null
   ```

2. **Read recent logs** (last 7 days):
   - Use `Glob` to find log files: `workspace/logs/**/*.md` or `workspace/chat/**/*.md`
   - Focus on the most recent interactions
   - Note: only read logs that are present; do not fail if none exist

3. **Extract interaction patterns**:
   - What types of requests do users make most frequently?
   - What features are actually being used vs. available?
   - Where do users encounter confusion or errors?

### Step 3: Simulate New User Scenarios

Based on the available skills and features, simulate the following new user experiences:

#### Scenario A: First-Time Discovery
- Imagine you are a user who just joined a chat group with this bot
- What would you try first? (greeting, asking what the bot can do, trying a command)
- Evaluate: Is the onboarding experience clear?

#### Scenario B: Feature Exploration
- Pick 3-5 available skills at random
- For each skill, evaluate from a new user's perspective:
  - Can I discover this feature naturally?
  - Is the trigger/intuitive keyword obvious?
  - What would the response quality be for a typical request?
  - Are there edge cases that would confuse a new user?

#### Scenario C: Error Recovery
- Think about what happens when things go wrong:
  - What if a user sends an unclear message?
  - What if a skill fails midway?
  - What if the user asks for something not supported?
  - Are error messages helpful or confusing?

#### Scenario D: Cross-Feature Interaction
- Consider how features interact:
  - Can a user naturally chain multiple skills?
  - Is context preserved across interactions?
  - Are there conflicts between features?

### Step 4: Generate Self-Experience Report

Create a structured report following this template:

```markdown
## 🎭 自我体验报告 (Dogfooding Report)

**体验时间**: [Timestamp]
**体验视角**: 新用户首次使用
**系统版本**: [Version if available]
**可用 Skills 数量**: [Count]

---

### 📊 体验总评

| 维度 | 评分 (1-5) | 说明 |
|------|-----------|------|
| 🎯 功能可发现性 | ⭐⭐⭐☆☆ | [说明] |
| 🤖 响应质量 | ⭐⭐⭐⭐☆ | [说明] |
| 🚀 上手难度 | ⭐⭐⭐☆☆ | [说明] |
| 🔧 错误处理 | ⭐⭐⭐☆☆ | [说明] |
| ✨ 整体体验 | ⭐⭐⭐⭐☆ | [说明] |

---

### 🎬 模拟场景体验

#### 场景 1: [Scenario Name]
**用户画像**: [What kind of user]
**操作路径**: [What the user tries to do]
**预期结果**: [What should happen]
**实际体验**: [What actually happens from analysis]
**改进建议**: [Specific actionable suggestion]

#### 场景 2: [Scenario Name]
...

---

### 🔴 发现的问题 (Must Fix)

#### 问题 1: [Problem Title]
- **严重程度**: High / Medium / Low
- **场景**: [In which scenario this occurs]
- **表现**: [What the user sees]
- **期望**: [What the user should see]
- **建议修复**: [How to fix]

---

### 🟡 改进机会 (Nice to Have)

#### 机会 1: [Opportunity Title]
- **描述**: [Description]
- **潜在收益**: [Expected benefit]
- **实现难度**: Easy / Medium / Hard

---

### ✅ 做得好的地方

- [List of things that work well from a user perspective]

---

### 📋 建议的下一步

1. **立即改进**: [High priority items that are easy to fix]
2. **计划改进**: [Medium priority items]
3. **长期方向**: [Strategic improvements]
```

### Step 5: Send Report

**CRITICAL**: Always send the report to the user using `send_user_feedback`.

```
Use send_user_feedback with:
- content: [The report in markdown format]
- format: "text"
- chatId: [The chatId from context]
```

---

## Quality Guidelines

### Good Self-Experience Reports:
- ✅ Based on actual system state and available features
- ✅ Written from a NEW USER's perspective (not developer's)
- ✅ Specific and actionable (not vague complaints)
- ✅ Balanced (highlights both problems AND successes)
- ✅ Includes concrete improvement suggestions

### Avoid:
- ❌ Writing from a developer's perspective
- ❌ Generic feedback that could apply to any system
- ❌ Only listing problems without suggestions
- ❌ Testing features that don't exist yet
- ❌ Skipping the simulation and just reading code

---

## Report Frequency

- **Scheduled execution**: Once per week (configurable in schedule.md)
- **Manual trigger**: Anytime via keywords
- **Version trigger**: After major version updates (when schedule detects change)

---

## Example

### Input (Available Skills):
```
skills/ directory contains:
- daily-chat-review
- bbs-topic-initiator
- pr-scanner
- schedule-recommend
- self-experience
```

### Output (Report Excerpt):

```markdown
## 🎭 自我体验报告 (Dogfooding Report)

**体验时间**: 2026-05-02
**体验视角**: 新用户首次使用
**可用 Skills 数量**: 5

---

### 📊 体验总评

| 维度 | 评分 (1-5) | 说明 |
|------|-----------|------|
| 🎯 功能可发现性 | ⭐⭐⭐☆☆ | 需要记忆关键词才能触发，没有引导菜单 |
| 🤖 响应质量 | ⭐⭐⭐⭐☆ | 日常对话流畅，复杂任务偶尔跑偏 |
| 🚀 上手难度 | ⭐⭐⭐☆☆ | 基础对话容易上手，高级功能需要学习 |
| 🔧 错误处理 | ⭐⭐☆☆☆ | 报错信息偏技术化，用户不易理解 |
| ✨ 整体体验 | ⭐⭐⭐☆☆ | 功能丰富但可发现性不足 |

---

### 🎬 模拟场景体验

#### 场景 1: 新用户询问"你能做什么"
**用户画像**: 刚加入群聊的新成员
**操作路径**: 发送"你好，你能做什么？"
**预期结果**: 清晰地列出主要功能和使用方式
**实际体验**: 可能只给出简短回复，缺少结构化功能介绍
**改进建议**: 添加统一的功能介绍回复，列出核心 Skills 及触发关键词

#### 场景 2: 尝试触发 BBS 话题生成
**用户画像**: 想要活跃群氛围的普通用户
**操作路径**: 发送"来个话题吧"
**预期结果**: 生成一个有趣的讨论话题
**实际体验**: 可能触发，但关键词"来个话题"可能不在触发列表中
**改进建议**: 扩展触发关键词，增加口语化表达

---

### 🔴 发现的问题

#### 问题 1: 功能可发现性不足
- **严重程度**: High
- **场景**: 新用户首次交互
- **表现**: 不知道系统能做什么，无法发现隐藏功能
- **期望**: 系统应主动介绍核心功能
- **建议修复**: 添加 /help 或 "你好" 触发的功能引导

---

### ✅ 做得好的地方

- 定时任务系统设计合理，自动化任务运行稳定
- 错误报告机制（/feedback）方便用户反馈问题
- Skill 系统架构清晰，扩展性好

---

### 📋 建议的下一步

1. **立即改进**: 添加新用户引导机制
2. **计划改进**: 优化 Skill 触发关键词的覆盖范围
3. **长期方向**: 建立用户体验度量体系
```

---

## Checklist

- [ ] Gathered system context (skills list, recent changes)
- [ ] Read recent interaction logs (if available)
- [ ] Simulated at least 3 new user scenarios
- [ ] Generated structured self-experience report
- [ ] Report includes specific, actionable suggestions
- [ ] **Sent report via send_user_feedback** (CRITICAL)

---

## DO NOT

- Generate reports without analyzing actual system state
- Write from a developer's perspective instead of a user's
- List problems without suggesting fixes
- Include sensitive information (API keys, user data, internal URLs)
- Create issues or PRs automatically (report only)
- Execute actual user simulation (this is analytical, not interactive)
