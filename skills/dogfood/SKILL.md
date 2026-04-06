---
name: dogfood
description: Self-experience and feedback skill - reviews disclaude's own capabilities, analyzes recent interactions for quality, and generates structured improvement reports. Use when user says "自我体验", "dogfood", "自测", "自我审查", "self-experience", "self-review", "self-audit", or when triggered by scheduler for post-release validation.
allowed-tools: [Read, Glob, Grep, Bash]
---

# Dogfood Skill

Self-experience and feedback specialist that reviews disclaude's own capabilities, audits interaction quality, and generates structured improvement reports.

## When to Use This Skill

**Use this skill for:**
- Post-release self-validation and quality audit
- Reviewing disclaude's own skill set and capabilities
- Analyzing recent interaction quality from a "new user" perspective
- Generating structured improvement reports
- Detecting documentation-implementation inconsistencies

**Keywords that trigger this skill**: "自我体验", "dogfood", "自测", "自我审查", "self-experience", "self-review", "self-audit", "体验报告", "质量检查"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Think like a new user exploring the system for the first time.**

The review should be guided by empathy: "If I were a new user encountering this system today, what would confuse me? What would impress me? What would I want to improve?"

---

## Self-Experience Process

### Phase 1: Environment Discovery

#### 1.1 Identify Current Version

```bash
# Read version from package.json
cat package.json | grep '"version"' | head -1
```

Record the current version for the report header.

#### 1.2 Catalog All Available Skills

Use `Glob` to discover all skill definitions:

```
skills/*/SKILL.md
```

For each skill found, read the YAML frontmatter to extract:
- Skill name
- Description and trigger keywords
- Allowed tools

Build a complete catalog of system capabilities.

#### 1.3 Review Recent Changes

```bash
# Check recent git log for changes since last report
git log --oneline --since="7 days ago" | head -30
```

Identify:
- New features added
- Bug fixes applied
- Refactoring work done
- Documentation updates

### Phase 2: Capability Audit

#### 2.1 Skill Completeness Check

For each skill in the catalog, verify:

| Check Item | How to Verify | Expected |
|------------|---------------|----------|
| SKILL.md exists | File exists | ✅ |
| Has YAML frontmatter | File starts with `---` | ✅ |
| Has description | `description:` field present | ✅ |
| Has allowed-tools | `allowed-tools:` field present | ✅ |
| Has workflow | Workflow section exists | ✅ |
| Has examples | Example section exists | Recommended |
| Has DO NOT section | Guardrails defined | Recommended |

#### 2.2 Documentation Consistency

Check for inconsistencies between:
- Skill descriptions and actual content
- Trigger keywords and actual usage patterns
- Documented tools and `allowed-tools` field
- Example outputs and actual behavior patterns

#### 2.3 Trigger Keyword Overlap Analysis

Analyze whether multiple skills compete for the same trigger keywords:

```
For each pair of skills:
  - Compare description keywords
  - Flag overlapping or ambiguous triggers
  - Note potential confusion points
```

### Phase 3: Interaction Quality Review

#### 3.1 Analyze Recent Chat Logs

Read recent chat logs from `workspace/logs/`:

```
workspace/logs/**/*.md
```

Focus on the last 7 days. For each conversation, analyze:

1. **Response Quality Indicators**:
   - Did the bot understand the user's intent correctly?
   - Were responses helpful and actionable?
   - Did the bot ask clarifying questions when needed?
   - Were there unnecessary retries or corrections?

2. **Error Patterns**:
   - Timeouts or failures
   - Misunderstood commands
   - Missing or incorrect tool usage
   - Unhandled edge cases

3. **User Satisfaction Signals**:
   - User corrections ("不对", "应该")
   - Repeated requests (indicates first attempt failed)
   - Explicit feedback (positive or negative)

#### 3.2 Edge Case Detection

Identify scenarios that might not be handled well:

- Very long messages
- Multi-language mixed input
- Ambiguous commands
- Rapid sequential messages
- Empty or minimal input

### Phase 4: Structured Report Generation

#### 4.1 Report Format

Generate a structured report in this format:

```markdown
## 🐕 Disclaude 自我体验报告

**版本**: {version}
**体验时间**: {timestamp}
**体验范围**: {skills_count} 个 Skill, {days} 天日志

---

### 📋 能力清单

| 类别 | 数量 | 详情 |
|------|------|------|
| 已注册 Skills | {n} | {list} |
| 定时任务 | {n} | {list} |
| MCP 工具 | {n} | {list} |

---

### ✅ 运行良好的方面

1. **{Aspect 1}**: {Description of what works well}
2. **{Aspect 2}**: {Description}

---

### ⚠️ 发现的问题

#### 问题 1: {Problem Title}
- **严重程度**: 🔴 高 / 🟡 中 / 🟢 低
- **类别**: {Bug / UX / Documentation / Performance}
- **描述**: {What's wrong}
- **影响**: {Who/what is affected}
- **建议修复**: {How to fix}

---

### 💡 改进建议

1. **{Suggestion 1}**: {Description and rationale}
2. **{Suggestion 2}**: {Description and rationale}

---

### 🎯 新用户视角体验评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 功能完整性 | ⭐⭐⭐⭐☆ | {Comment} |
| 文档清晰度 | ⭐⭐⭐⭐☆ | {Comment} |
| 交互流畅度 | ⭐⭐⭐⭐⭐ | {Comment} |
| 错误处理 | ⭐⭐⭐☆☆ | {Comment} |
| 新手友好度 | ⭐⭐⭐⭐☆ | {Comment} |

---

*报告由 Dogfood Skill 自动生成 | 版本 {version} | {timestamp}*
```

#### 4.2 Report Output

Save the report to `workspace/reports/dogfood-{YYYY-MM-DD}.md` and send a summary via `send_user_feedback`.

---

## Non-Deterministic Exploration

To ensure each run produces fresh insights, vary the exploration focus:

| Run Focus | Exploration Angle | Example Activities |
|-----------|-------------------|-------------------|
| **Skill Deep Dive** | Pick 2-3 random skills, read them thoroughly, test trigger keywords | Read full SKILL.md, analyze workflow completeness |
| **Log Archaeology** | Focus on oldest available logs, identify long-term patterns | Trend analysis, recurring issue detection |
| **Edge Case Hunt** | Deliberately look for unhandled scenarios | Empty input, emoji-only, code snippets, mixed language |
| **Documentation Audit** | Cross-reference all docs with implementation | README vs actual behavior, changelog completeness |
| **User Journey Simulation** | Simulate a complete user onboarding flow | First greeting, skill discovery, task creation, feedback |

**Selection strategy**: Use the current date's hash or random selection to pick one focus area per run. Over multiple runs, all areas will be covered naturally.

---

## Schedule Configuration

To enable periodic self-experience, create a schedule file in `schedules/`:

```markdown
---
name: "Dogfood 自我体验"
cron: "0 10 * * 1"  # Every Monday at 10:00 AM
enabled: true
blocking: true
chatId: "{your_chat_id}"
---

请使用 dogfood skill 执行一次自我体验并生成报告。

要求：
1. 识别当前版本和最近变更
2. 审查所有 Skill 的完整性和一致性
3. 分析最近 7 天的聊天日志质量
4. 使用随机探索焦点（基于日期选择）
5. 生成结构化报告并保存到 workspace/reports/
6. 使用 send_user_feedback 发送报告摘要

注意：
- 保持新用户视角，关注实际体验
- 问题要具体，附带复现步骤
- 改进建议要可执行，不要空泛
```

---

## Anti-Patterns to Detect

When reviewing, actively look for these common issues:

| Anti-Pattern | Detection Method | Severity |
|--------------|-----------------|----------|
| Overly verbose responses | Response > 500 words for simple questions | 🟡 |
| Missing error handling | Error logs without user-facing explanation | 🔴 |
| Stale documentation | Doc references removed/nonexistent features | 🟡 |
| Hardcoded values | Config values that should be configurable | 🟢 |
| Inconsistent naming | Different terms for the same concept | 🟢 |
| Missing guardrails | Skills without DO NOT sections | 🟡 |

---

## Integration with Other Skills

- **daily-chat-review**: Provides chat log analysis that dogfood can leverage
- **feedback**: Use to submit discovered issues as GitHub issues
- **schedule-recommend**: Can recommend optimal dogfood execution schedule
- **reporter**: Format reports for user delivery

---

## Checklist

- [ ] Identified current version and recent changes
- [ ] Cataloged all available skills
- [ ] Verified skill completeness (frontmatter, workflow, guardrails)
- [ ] Analyzed recent chat logs (last 7 days)
- [ ] Checked documentation consistency
- [ ] Detected trigger keyword overlaps
- [ ] Selected non-deterministic exploration focus
- [ ] Generated structured report
- [ ] Saved report to `workspace/reports/dogfood-{date}.md`
- [ ] Sent summary via `send_user_feedback`

---

## DO NOT

- Create GitHub issues automatically without user confirmation
- Modify any system files or configurations during review
- Execute skills or tools with destructive side effects
- Include sensitive user data (IDs, tokens, chat content) in reports
- Generate generic feedback without specific examples
- Skip the non-deterministic exploration focus selection
- Run destructive tests that could break the production system
- Report issues without suggesting concrete fixes
