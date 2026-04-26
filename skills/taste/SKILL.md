---
name: taste
description: Manage user taste (preference) rules that the Agent automatically follows. Use when user says keywords like "taste", "偏好", "preference", "我的习惯", "taste list", "taste edit", "taste reset", or wants to add/view/edit/clear learned preferences.
allowed-tools: Read, Write, Bash
---

# Taste (Preference) Management

Manage the user's learned preferences so the Agent can automatically follow them.

## Commands

### `/taste list`
Show all learned preferences for the current context.

### `/taste add <category> <rule>`
Add a new preference rule manually.

**Categories**: `code_style`, `interaction`, `technical`, `project_convention`, `other`

**Examples**:
- `/taste add code_style Use const/let, never var`
- `/taste add interaction Reply concisely, give conclusion first`
- `/taste add technical Prefer TypeScript over JavaScript`
- `/taste add project_convention Commit messages in Chinese`

### `/taste edit <index> <new-rule>`
Edit an existing preference rule by its index number.

**Example**:
- `/taste edit 2 Reply briefly with key info only`

### `/taste remove <index>`
Remove a preference rule by its index number.

**Example**:
- `/taste remove 3`

### `/taste reset`
Clear all learned preferences.

---

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

---

## Implementation Guide

The taste system uses the TasteManager module from `packages/core/src/taste/`.

### Data Location

Taste data is persisted in `workspace/.disclaude/taste.json`.

### Reading Taste Data

Read the taste.json file directly:

```bash
# Read workspace-level tastes
cat workspace/.disclaude/taste.json
```

Or use the Read tool on `workspace/.disclaude/taste.json`.

### Taste Entry Format

Each taste entry has:
- `rule` (string): The preference rule text
- `category` (string): One of `code_style`, `interaction`, `technical`, `project_convention`, `other`
- `source` (string): `manual`, `auto`, or `claude_md`
- `correctionCount` (number): How many times this was corrected (weight signal)
- `lastSeen` (string): ISO 8601 timestamp of last update
- `createdAt` (string): ISO 8601 timestamp of creation

### Taste File Schema

```json
{
  "workspace": [
    {
      "rule": "Use const/let, never var",
      "category": "code_style",
      "source": "manual",
      "correctionCount": 0,
      "lastSeen": "2026-04-26T00:00:00.000Z",
      "createdAt": "2026-04-26T00:00:00.000Z"
    }
  ],
  "projects": {
    "project-name": [
      {
        "rule": "Project-specific rule",
        "category": "project_convention",
        "source": "manual",
        "correctionCount": 0,
        "lastSeen": "2026-04-26T00:00:00.000Z",
        "createdAt": "2026-04-26T00:00:00.000Z"
      }
    ]
  }
}
```

---

## Command Handling

### `/taste list`

1. Read `workspace/.disclaude/taste.json`
2. If file doesn't exist or is empty, show "No taste rules configured yet."
3. Display rules grouped by category in a table:

```markdown
## 📋 User Preferences

| # | Category | Rule | Source | Corrections |
|---|----------|------|--------|-------------|
| 1 | code_style | Use const/let, never var | manual | 0 |
| 2 | interaction | Reply concisely | auto | 3 |
```

4. Show summary: "Total: X rules (Y auto-detected, Z manual)"

### `/taste add <category> <rule>`

1. Parse category and rule from arguments
2. Validate category is one of: `code_style`, `interaction`, `technical`, `project_convention`, `other`
3. Read existing taste.json (create if not exists)
4. Add new entry with `source: "manual"` and current timestamp
5. Write back using atomic pattern
6. Confirm: "✅ Added taste rule: {rule} [{category}]"

### `/taste edit <index> <new-rule>`

1. Parse index (0-based) and new rule text
2. Read taste.json
3. Validate index is in range
4. Update the rule text and `lastSeen` timestamp
5. Write back
6. Confirm: "✅ Updated taste rule #{index}: {new-rule}"

### `/taste remove <index>`

1. Parse index (0-based)
2. Read taste.json
3. Validate index is in range
4. Show the rule being removed
5. Remove it
6. Write back
7. Confirm: "✅ Removed taste rule #{index}: {removed rule}"

### `/taste reset`

1. Ask for confirmation if not already given
2. Clear all taste rules
3. Write empty structure
4. Confirm: "✅ All taste rules have been cleared."

---

## Error Handling

- If taste.json is corrupted, show error and suggest `/taste reset`
- If index is out of bounds, show available range
- If category is invalid, list valid categories
- If rule text is empty, show usage example

## DO NOT

- Remove auto-detected rules without user confirmation
- Add taste rules that the user didn't explicitly request
- Modify the taste.json schema format
- Create taste rules that duplicate existing ones
