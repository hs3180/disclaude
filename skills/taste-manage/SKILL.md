---
name: taste-manage
description: Taste preference management - view, add, remove, and reset user taste rules (auto-learned preferences). Use when user says keywords like "taste", "偏好", "偏好管理", "taste list", "taste add", "taste reset", "查看偏好", "添加偏好", "重置偏好".
allowed-tools: Read, Write, Bash, send_user_feedback
---

# Taste Preference Management

Manage user taste (preference) rules that have been auto-learned or manually set.

## When to Use This Skill

**Use this skill for:**
- Viewing current taste rules (`/taste list`)
- Adding taste rules manually (`/taste add`)
- Removing specific taste rules (`/taste remove`)
- Resetting auto-detected taste rules (`/taste reset`)
- Checking taste configuration

**Keywords**: "taste", "偏好", "偏好管理", "查看偏好", "添加偏好", "重置偏好"

## Context Variables

- **Chat ID**: From `**Chat ID:** xxx` in the message
- **Message ID**: From `**Message ID:** xxx` in the message

---

## Taste Storage

Taste rules are stored as YAML files:
- **With project context**: `workspace/projects/{projectName}/taste.yaml`
- **Without project context**: `workspace/.disclaude/taste.yaml`

Each rule has:
- `description` — What the preference is
- `category` — Grouping category (code_style, tech_choice, interaction, project_convention, other)
- `source` — Where it came from (auto, manual, claude_md)
- `correctionCount` — How many times user corrected this (0 for manual)
- `lastSeenAt` — Last observation timestamp
- `createdAt` — Creation timestamp

---

## Commands

### `/taste list` — View All Taste Rules

**Actions:**
1. Use `Read` tool to read the taste.yaml file:
   - First check `workspace/.disclaude/taste.yaml`
   - If not found, check project-specific `workspace/projects/*/taste.yaml`
2. If no taste file exists, respond: "暂无 taste 规则。当你反复纠正同一类问题时，系统会自动记录你的偏好。"
3. If rules exist, format them as a readable table:

```
📋 当前 Taste 规则 (共 N 条)

| # | 偏好 | 类别 | 来源 | 纠正次数 |
|---|------|------|------|----------|
| 1 | 使用 const/let，禁止 var | 代码风格 | 自动 | 3 |
| 2 | 回复简洁，先结论后分析 | 交互习惯 | 手动 | 0 |

💡 使用 `/taste add` 添加新规则，`/taste remove` 删除规则，`/taste reset` 重置自动规则
```

### `/taste add` — Add Taste Rule

**Usage**: `/taste add <description> [--category <cat>]`

**Actions:**
1. Parse the description from the user's message after `/taste add`
2. If `--category` is specified, use it; otherwise infer from context or default to `other`
3. Read the existing taste.yaml file (or create empty if missing)
4. Append the new rule with `source: manual`
5. Write the updated taste.yaml using atomic write (write .tmp then rename)
6. Respond with confirmation: "✅ 已添加 taste 规则: {description}"

**Category options**: `code_style`, `tech_choice`, `interaction`, `project_convention`, `other`

### `/taste remove` — Remove Taste Rule

**Usage**: `/taste remove <index-or-description>`

**Actions:**
1. Read the taste.yaml file
2. Find the rule by index (from `/taste list` output) or by description substring match
3. Remove the matching rule
4. Write the updated taste.yaml
5. Respond with confirmation: "✅ 已移除 taste 规则: {description}"

### `/taste reset` — Reset Auto-Detected Rules

**Actions:**
1. Read the taste.yaml file
2. Remove all rules with `source: auto`
3. Keep rules with `source: manual` and `source: claude_md`
4. Write the updated taste.yaml
5. Respond: "✅ 已重置 {N} 条自动检测的 taste 规则。保留了 {M} 条手动/CLAUDE.md 规则。"

---

## Taste File Format (YAML)

```yaml
version: 1
rules:
  - description: "使用 const/let，禁止 var"
    category: code_style
    source: auto
    correctionCount: 3
    lastSeenAt: "2026-04-14T10:30:00Z"
    createdAt: "2026-04-10T08:00:00Z"
  - description: "回复简洁，先结论后分析"
    category: interaction
    source: manual
    correctionCount: 0
    lastSeenAt: "2026-04-12T15:00:00Z"
    createdAt: "2026-04-12T15:00:00Z"
```

---

## How Auto-Detection Works

When the system detects repeated corrections (e.g., user says "不对，用 const 不要用 var" multiple times), it creates an `auto` taste rule. The agent then sees these rules at the start of each session and follows them proactively.

Detection signals:
- User corrects the same type of issue 2+ times
- Pattern: "不对...", "应该是...", "改成...", "不要用..."
- User manually modifies agent output in consistent ways

---

## Checklist

- [ ] Located the correct taste.yaml file
- [ ] Read and parsed the YAML content
- [ ] Performed the requested operation (list/add/remove/reset)
- [ ] Wrote changes using atomic write pattern
- [ ] Sent confirmation to user

---

## DO NOT

- Delete manual or claude_md rules during `/taste reset` (only reset auto rules)
- Create taste rules for one-time corrections (need 2+ occurrences)
- Modify rules from other projects
- Send responses without confirming the action taken
