---
name: taste
description: User taste (preference) management - view, add, edit, remove auto-learned preferences. Use when user says keywords like "taste", "偏好", "我的偏好", "preference", "/taste".
allowed-tools: Read, Bash, Glob
---

# Taste Manager

Manage auto-learned user preferences (taste rules).

## When to Use This Skill

**Use this skill for:**
- Viewing all learned preferences (`/taste list`)
- Adding a new preference rule (`/taste add`)
- Removing a preference rule (`/taste remove`)
- Clearing all preferences (`/taste reset`)

**Keywords that trigger this skill**: "taste", "偏好", "我的偏好", "preference", "/taste"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

---

## Taste Storage

Taste rules are stored in `workspace/.disclaude/taste.json` as JSON.

Each rule has:
- `id`: Unique identifier
- `category`: One of `code_style`, `interaction`, `tech_choice`, `project_norm`, `custom`
- `description`: The preference rule text
- `source`: `auto`, `manual`, or `claude_md`
- `count`: How many times this preference was observed
- `createdAt`: When the rule was created
- `lastSeen`: When the rule was last observed

---

## Commands

### `/taste list` — View all preferences

Read `workspace/.disclaude/taste.json` and display all rules grouped by category.

**Steps:**
1. Read `workspace/.disclaude/taste.json` using the Read tool
2. If the file doesn't exist, report "No taste rules found"
3. Parse and group rules by category
4. Display in a formatted table

**Display format:**
```markdown
## 🎯 User Preferences

### 代码风格 (code_style)
| # | Preference | Source | Times |
|---|-----------|--------|-------|
| 1 | Use const/let, no var | auto | 3 |

### 交互偏好 (interaction)
| # | Preference | Source | Times |
|---|-----------|--------|-------|
| 1 | Reply concisely | manual | 1 |

📊 Total: 2 rules
```

If there are no rules, show:
```
📊 No taste rules configured. You can add rules with `/taste add`.
```

---

### `/taste add <category> <description>` — Add a preference

Add a new preference rule manually.

**Steps:**
1. Parse category and description from user message
2. Validate category is one of: `code_style`, `interaction`, `tech_choice`, `project_norm`, `custom`
3. Read existing taste.json (or create new)
4. Add the rule with `source: "manual"`
5. Write updated taste.json
6. Confirm to user

**Example usage:**
- `/taste add code_style Use const/let, no var`
- `/taste add interaction Reply in Chinese`
- `/taste add tech_choice Prefer TypeScript over JavaScript`

**Confirmation message:**
```
✅ Added taste rule:
- Category: {category}
- Description: {description}
```

---

### `/taste remove <id>` — Remove a preference

Remove a preference rule by its ID.

**Steps:**
1. Parse the rule ID from user message
2. Read taste.json
3. Find and remove the rule
4. Write updated taste.json
5. Confirm to user

**Confirmation message:**
```
🗑️ Removed taste rule: {description}
```

---

### `/taste reset` — Clear all preferences

Remove all taste rules after confirmation.

**Steps:**
1. Read taste.json to show current rules
2. Ask for confirmation
3. If confirmed, write empty rules
4. Confirm to user

**Confirmation message:**
```
🗑️ All taste rules have been cleared.
```

---

## Categories Reference

| Category | Chinese | Example |
|----------|---------|---------|
| `code_style` | 代码风格 | "Use const/let, no var", "Use camelCase" |
| `interaction` | 交互偏好 | "Reply concisely", "Use Chinese" |
| `tech_choice` | 技术选择 | "Prefer TypeScript", "Use pnpm" |
| `project_norm` | 项目规范 | "Tests in __tests__/", "Commit msg in Chinese" |
| `custom` | 自定义 | Any other preference |

---

## DO NOT

- Delete taste rules without user confirmation
- Modify taste.json without reading it first
- Create taste rules from single occurrences (wait for ≥2 corrections)
- Guess or infer preferences the user hasn't expressed
