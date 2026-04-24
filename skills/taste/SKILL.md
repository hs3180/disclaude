---
name: taste
description: Manage user taste preferences (code style, interaction habits, tech preferences) to avoid repeated corrections. Use when user says "taste", "preference", "偏好", "喜好", or wants to view/edit/reset their learned preferences.
argument-hint: [list|add|edit|reset]
disable-model-invocation: false
---

# Taste Preference Manager

You manage the user's taste (preferences) for the current project. Taste rules are auto-learned from repeated user corrections and help the Agent follow user preferences automatically.

## Command Reference

The user invokes this skill with `/taste [subcommand]`.

### Subcommands

| Command | Description | Example |
|---------|-------------|---------|
| `/taste list` | Show all taste rules for the current project | `/taste list` |
| `/taste add <category> <content>` | Add a new taste rule | `/taste add code_style 使用 const/let，禁止 var` |
| `/taste edit <id> <content>` | Edit an existing rule's content | `/taste edit t_xxx_yyy Updated preference text` |
| `/taste reset` | Clear all taste rules for the current project | `/taste reset` |

### Categories

| Category | Chinese Label | Description |
|----------|---------------|-------------|
| `code_style` | 代码风格 | Code formatting, naming conventions |
| `interaction` | 交互偏好 | How the agent should respond (concise, detailed, etc.) |
| `tech_preference` | 技术选择 | Preferred technologies (TypeScript over JS, pnpm over npm) |
| `project_norm` | 项目规范 | Project-specific conventions (test directories, commit message format) |
| `other` | 其他偏好 | Any other preferences |

## Implementation

TasteManager is implemented in `packages/core/src/project/taste-manager.ts`.

### Storage Location
- Taste data is stored in `{workspace}/.disclaude/taste/{projectName}.json`
- "default" project uses `default.json`
- Named projects use `{projectName}.json`

### How to Use TasteManager

```typescript
import { TasteManager } from '@disclaude/core/project';

const tm = new TasteManager({ workspaceDir: '/path/to/workspace' });

// Add a taste rule
const result = tm.addRule('default', {
  category: 'code_style',
  content: '使用 const/let，禁止 var',
  source: 'manual', // or 'auto', 'claude_md'
});

// List rules
const rules = tm.listRules('default');

// Generate prompt for Agent context
const prompt = tm.getTastePrompt('default');

// Reset all rules
tm.resetTaste('default');
```

## Behavior

1. **`/taste` or `/taste list`**: Display all taste rules for the current project, grouped by category with correction counts
2. **`/taste add`**: Parse the category and content, validate, and add the rule. Show confirmation.
3. **`/taste edit`**: Update a specific rule's content. Show before/after.
4. **`/taste reset`**: Ask for confirmation, then clear all rules. Show count of removed rules.

## Response Format

Always respond with a formatted card or markdown showing:
- Rule ID (for edit/delete reference)
- Category label (in Chinese)
- Content
- Source (auto/manual/claude_md)
- Correction count
- Last seen date
