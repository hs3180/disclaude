---
name: taste
description: Manage user taste (preferences) for the current project. Use when user says keywords like "偏好设置", "taste", "add preference", "我的喜好", "代码风格偏好", or wants to view/add/remove their coding and interaction preferences.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Taste Manager — User Preference Management

Manage per-project user preferences (taste) so the Agent can automatically follow them without repeated corrections.

## When to Use This Skill

**Use this skill for:**
- Adding new preference rules (`/taste add`)
- Viewing existing preferences (`/taste list`)
- Removing preferences (`/taste remove`)
- Clearing all preferences (`/taste reset`)

**Keywords that trigger this skill**: "偏好", "taste", "preference", "喜好", "代码风格", "交互偏好"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Commands

### `/taste list` — View all preferences

Show all configured taste rules grouped by category.

**Actions:**
1. Read the taste.yaml file from the project's working directory
2. The file is located at `{workspaceDir}/taste.yaml` or `{workspaceDir}/projects/{name}/taste.yaml` for project instances
3. Display rules grouped by category in a readable format

**Output format:**
```
📋 当前项目偏好设置

### 代码风格 (code_style)
- 使用 const/let，禁止 var
- 函数名使用 camelCase

### 交互偏好 (interaction)
- 回复简洁，先结论后分析
- 使用中文 commit message

### 技术选择 (technical)
- 优先 TypeScript
- 用 pnpm 不要用 npm

共 X 条偏好规则
```

If no taste.yaml exists, display: "暂无偏好设置，使用 `/taste add` 添加。"

---

### `/taste add <category> <rule>` — Add a preference

Add a new taste rule to the specified category.

**Arguments:**
- `$0` — Category: `code_style`, `interaction`, `technical`, or `custom`
- `$1..` — The preference rule text

**Steps:**
1. Parse the category and rule text from arguments
2. Validate category is one of: `code_style`, `interaction`, `technical`, `custom`
3. Read existing taste.yaml (or create empty)
4. Add the new rule to the appropriate category
5. Save the file

**YAML format:**
```yaml
taste:
  code_style:
    - rule: "使用 const/let，禁止 var"
      category: code_style
      source: manual
      addedAt: "2026-04-19T12:00:00.000Z"
```

**Success message:** "✅ 已添加偏好: 「{rule}」→ {category}"

**Error cases:**
- Missing arguments: "❌ 用法: `/taste add <category> <rule>`"
- Invalid category: "❌ 无效类别。有效值: code_style, interaction, technical, custom"
- Duplicate rule: "⚠️ 该偏好已存在"

---

### `/taste remove <category> <rule>` — Remove a preference

Remove an existing taste rule.

**Arguments:**
- `$0` — Category
- `$1..` — The exact rule text to remove

**Steps:**
1. Parse the category and rule text
2. Read taste.yaml
3. Find and remove the matching rule
4. Save the file

**Success message:** "✅ 已移除偏好: 「{rule}」"

---

### `/taste reset` — Clear all preferences

Remove all taste rules for the current project.

**Steps:**
1. Confirm with the user before clearing
2. Delete or clear the taste.yaml file

**Success message:** "✅ 已清空所有偏好设置"

---

## Category Reference

| Category | Label | Examples |
|----------|-------|---------|
| `code_style` | 代码风格 | 命名规范、缩进风格、禁止使用的语法 |
| `interaction` | 交互偏好 | 回复长度、语气、回复格式 |
| `technical` | 技术选择 | 框架偏好、包管理器、语言版本 |
| `custom` | 自定义 | 任何其他偏好 |

---

## File Location

Taste data is stored as `taste.yaml` in the project's working directory:

- **Default project**: `{workspaceDir}/taste.yaml`
- **Named project instance**: `{workspaceDir}/projects/{name}/taste.yaml`

---

## DO NOT

- Create taste.yaml without explicit user request
- Auto-detect preferences (future feature, not yet implemented)
- Share taste data across different projects
- Overwrite taste.yaml without reading it first
