---
name: taste
description: User taste (preferences) management - detect, record, and apply user preferences automatically. Use when user repeatedly corrects the agent, or says keywords like "taste", "偏好", "我喜欢", "不要这样", "preference", "记住这个". Triggered by user corrections or explicit taste management requests.
allowed-tools: Read, Write, Edit, Bash, Glob
---

# Taste Management Skill

Automatically detect and manage user preferences (taste) to avoid repeated corrections.

## When to Use This Skill

**Use this skill when:**
- User corrects your output and says things like "不要用 var", "用中文回复", "简洁一点"
- User explicitly asks to manage preferences: "taste list", "查看偏好", "记住我喜欢..."
- User repeatedly asks for the same style/format
- Daily chat review detects repetitive correction patterns

**Keywords that trigger this skill**: "taste", "偏好", "我喜欢", "记住", "preference", "不要这样", "总是要"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

---

## Core Principle

**Detect user corrections → Record as taste rules → Apply in future interactions.**

The taste system stores user preferences in `workspace/.disclaude/taste.yaml`, organized by category:
- `code_style` — Code formatting, naming, patterns
- `interaction` — Reply style, language, verbosity
- `technical` — Framework choices, tool preferences
- `project_norms` — Testing, commit, directory conventions

---

## Operations

### Detect and Record Taste

When you observe the user correcting your behavior:

1. **Identify the correction pattern**:
   - User says "不对，应该是..." or "改成..." → This is a correction
   - User edits your code/output → This is a correction
   - User explicitly requests a style → Record it

2. **Record the taste rule** by editing `workspace/.disclaude/taste.yaml`:

```yaml
taste:
  code_style:
    - description: "使用 const/let，禁止 var"
      source: auto
      correctionCount: 3
      lastSeen: "2026-04-14T10:00:00.000Z"
      createdAt: "2026-04-14T08:00:00.000Z"
```

3. **Rules for recording**:
   - `description`: Clear, actionable statement (e.g., "使用 const/let，禁止 var")
   - `source`: Use `auto` for detected corrections, `manual` for explicit requests
   - `correctionCount`: Increment each time the same correction is detected
   - `lastSeen`: ISO 8601 timestamp of latest correction
   - Maximum 20 rules per category (oldest/least-corrected are evicted)

### List Current Taste

When user asks to view preferences:

1. Read `workspace/.disclaude/taste.yaml`
2. Display all rules grouped by category:

```markdown
## 📋 当前用户偏好

### 代码风格
1. 使用 const/let，禁止 var（被纠正 3 次）
2. 函数名使用 camelCase（被纠正 2 次）

### 交互偏好
1. 回复简洁，先结论后分析（手动设置）
```

### Reset Taste

When user asks to clear preferences:

1. Ask for confirmation (full reset or specific category)
2. Clear the corresponding section in `workspace/.disclaude/taste.yaml`
3. Confirm what was removed

---

## Detection Signals

| Signal | Pattern | Category |
|--------|---------|----------|
| Code correction | "不要用 var", "用 const" | `code_style` |
| Naming preference | "camelCase", "snake_case" | `code_style` |
| Language preference | "用中文", "回复要简洁" | `interaction` |
| Tech preference | "用 pnpm", "优先 TypeScript" | `technical` |
| Project convention | "测试放 __tests__", "commit 用中文" | `project_norms` |
| Format preference | "先给结论再分析", "不要啰嗦" | `interaction` |

## Important Notes

- Only record taste when the user clearly expresses a preference or corrects you
- Do NOT record one-time requests or context-specific instructions
- Each taste rule should be generalizable across conversations
- When a taste rule is followed, you may briefly note it: "（基于你的偏好：xxx）"
- The taste file is automatically loaded into your context via the taste guidance system

## File Format

The taste file is at `workspace/.disclaude/taste.yaml`:

```yaml
# User taste rules (auto-learned preferences)
# @see Issue #2335
taste:
  code_style:
    - description: "使用 const/let，禁止 var"
      source: auto
      correctionCount: 3
      lastSeen: "2026-04-14T10:00:00.000Z"
      createdAt: "2026-04-14T08:00:00.000Z"
  interaction:
    - description: "回复简洁，先结论后分析"
      source: manual
      lastSeen: "2026-04-14T12:00:00.000Z"
      createdAt: "2026-04-14T12:00:00.000Z"
```
