---
name: taste
description: Manage user preferences (taste) — add, list, edit, and reset auto-learned preferences that the agent follows to avoid repeated corrections. Use when user says keywords like "taste", "偏好", "我的习惯", "记住这个", "/taste".
allowed-tools: Read, Write, Edit, Glob, Bash
---

# User Taste Management

Manage user preferences (taste) to avoid repeated corrections across sessions.

## When to Use This Skill

**Use this skill for:**
- Adding user preferences that the agent should remember
- Listing current preferences
- Editing or resetting preferences
- When the user says "记住这个偏好", "以后都要这样", "不要再犯这个错误"

**Keywords that trigger this skill**: "taste", "偏好", "我的习惯", "记住这个", "/taste", "preference"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Core Principle

**Persist user preferences to a shared taste file that gets injected into every Agent session.**

The taste system stores rules about how the user wants the agent to behave, grouped by category:
- **Code style** (代码风格): naming conventions, preferred syntax
- **Interaction** (交互偏好): response format, tone, language
- **Tech preference** (技术选择): frameworks, tools, libraries
- **Project convention** (项目规范): file structure, commit messages
- **Other** (其他偏好): any other preferences

---

## Commands

### `/taste list` — View all preferences

List all stored taste rules, grouped by category.

**Actions:**
1. Read the taste file from `workspace/.disclaude/taste/{chatId}.json`
2. If the file doesn't exist, report "No preferences set yet"
3. Format and display all rules grouped by category
4. Show correction count and source for each rule

**Example output:**
```
📋 你的偏好设置 (6 条规则)

🎨 代码风格
  1. 使用 const/let，禁止 var [自动学习, 被纠正3次] (严格遵守)
  2. 函数名使用 camelCase [自动学习, 被纠正2次]
  3. 优先使用 TypeScript [手动添加, 被纠正1次]

💬 交互偏好
  4. 回复简洁，先结论后分析 [手动添加, 被纠正2次]
  5. 使用中文 commit message [自动学习, 被纠正3次] (严格遵守)
```

### `/taste add <rule>` — Add a preference

Add a new taste rule manually.

**Actions:**
1. Parse the rule from the user's message (text after `/taste add`)
2. Optionally parse category: `/taste add --category code_style 使用 const/let`
3. If no category specified, try to infer from the rule content:
   - Contains code terms (var, function, class, import) → `code_style`
   - Contains interaction terms (回复, 格式, 语言) → `interaction`
   - Contains tech names (TypeScript, React, pnpm) → `tech_preference`
   - Otherwise → `other`
4. Read the taste file, or create if not exists
5. Check for duplicates (case-insensitive match)
6. Add the rule with `source: "manual"` and `correctionCount: 1`
7. Save the file using atomic write
8. Confirm to the user

**Example:**
```
User: /taste add 使用 pnpm 而不是 npm
Bot: ✅ 已添加偏好：使用 pnpm 而不是 npm (技术选择)

该偏好将在后续会话中自动生效。
```

### `/taste remove <id>` — Remove a preference

Remove a specific taste rule by its ID.

**Actions:**
1. Parse the rule ID from the message
2. Read the taste file
3. Find and remove the entry
4. Save the file
5. Confirm removal

### `/taste reset` — Clear all preferences

Remove all taste rules for the current chatId.

**Actions:**
1. Ask for confirmation
2. If confirmed, clear the taste file
3. Confirm reset

### `/taste edit <id> <new_rule>` — Edit a preference

Update the text of an existing taste rule.

**Actions:**
1. Parse the rule ID and new text
2. Read the taste file
3. Update the entry
4. Save the file
5. Confirm the change

---

## Taste File Format

The taste file is stored at `workspace/.disclaude/taste/{chatId}.json`:

```json
{
  "version": 1,
  "chatId": "oc_xxx",
  "entries": [
    {
      "id": "t_xxx_xxx",
      "rule": "使用 const/let，禁止 var",
      "category": "code_style",
      "source": "auto",
      "correctionCount": 3,
      "firstSeen": "2026-04-14T10:00:00.000Z",
      "lastSeen": "2026-04-14T15:00:00.000Z"
    }
  ],
  "meta": {
    "updatedAt": "2026-04-14T15:00:00.000Z",
    "totalRules": 1,
    "version": 1
  }
}
```

---

## Category Inference Rules

When adding a rule without explicit category, use these heuristics:

| Keywords | Category |
|----------|----------|
| var, let, const, function, class, import, export, naming, 命名 | `code_style` |
| 回复, 格式, 语言, 简洁, 详细, emoji, markdown | `interaction` |
| TypeScript, React, pnpm, npm, yarn, Python, Go, framework | `tech_preference` |
| 目录, 文件, 测试, commit, 测试文件 | `project_convention` |
| (anything else) | `other` |

---

## Integration with Other Skills

| Skill | Relationship |
|-------|-------------|
| daily-chat-review | Can extract taste signals from daily chat analysis |
| skill-creator | Can create custom skills based on user preferences |

---

## DO NOT

- Delete taste files without user confirmation
- Add taste rules that the user didn't explicitly request (in this skill; auto-detection is done by daily-chat-review)
- Modify taste files for other chatIds
- Expose taste rules from other users
