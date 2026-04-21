---
name: taste-summarizer
description: Auto-summarize user taste and preferences from chat history. Detects repeated corrections, extracts preference rules, and persists them for future sessions. Use when user says keywords like "taste", "偏好", "用户偏好", "总结偏好", "我的习惯", "/taste". Also integrates with daily-chat-review for automated taste extraction.
allowed-tools: Read, Write, Glob, Bash, send_user_feedback
---

# Taste Summarizer — Auto-learned User Preferences

Analyze chat history to detect repeated user corrections, extract preference rules, and persist them so the agent follows them automatically in future interactions.

## When to Use This Skill

**Use this skill for:**
- `/taste` — Show current taste summary and statistics
- `/taste update` — Re-analyze chat logs and update taste rules
- `/taste list` — List all taste rules grouped by category
- `/taste edit` — Edit taste rules manually
- `/taste reset` — Clear all taste rules
- Automated daily taste extraction (triggered by daily-chat-review)

**Keywords that trigger this skill**: "taste", "偏好", "用户偏好", "总结偏好", "我的习惯", "preference", "correction pattern"

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")
- **Sender Open ID**: Sender's open ID (from "**Sender Open ID:** xxx")

---

## Storage Location

Taste rules are persisted at:

```
workspace/.disclaude/taste.json
```

**File Schema:**

```json
{
  "version": 1,
  "rules": [
    {
      "rule": "使用 const/let，禁止 var",
      "category": "code_style",
      "source": "auto",
      "count": 3,
      "lastSeen": "2026-04-14T00:00:00.000Z"
    }
  ],
  "updatedAt": "2026-04-14T12:00:00.000Z"
}
```

---

## Taste Detection Process

### Step 1: Read Chat Logs

Read all chat log files from the logs directory:

```
workspace/logs/**/*.md
```

**Actions:**
1. Use `Glob` to find all log files: `workspace/logs/**/*.md`
2. Read each log file with `Read` tool
3. Focus on recent logs (last 14 days recommended for better pattern detection)

### Step 2: Detect Correction Patterns

Analyze the chat history to identify **user corrections** — moments where the user explicitly corrects or overrides the agent's behavior. Look for these patterns:

| Pattern | Examples | Category |
|---------|----------|----------|
| **Code style corrections** | "不要用 var", "函数名用 camelCase", "用 TypeScript" | `code_style` |
| **Interaction corrections** | "回复简洁", "不要啰嗦", "先给结论", "用中文回复" | `interaction` |
| **Technical choices** | "用 pnpm 不要用 npm", "用 vitest 不要用 jest" | `technical` |
| **Project norms** | "测试文件放在 `__tests__/`", "commit 用中文" | `project_norm` |
| **General preferences** | Any other repeated corrections | `general` |

**Detection signals:**
- User says "不对...", "应该是...", "改成...", "不要...", "换成..."
- User manually modifies agent-generated content in a consistent way
- User writes preferences in CLAUDE.md
- Same correction pattern appears **2+ times** across conversations

### Step 3: Read Existing Taste Rules

Before updating, read the existing taste file:

```
Read workspace/.disclaude/taste.json
```

If the file doesn't exist, start fresh.

### Step 4: Merge and Update Rules

**Merging strategy:**
1. Keep existing rules that are still valid
2. Update `count` and `lastSeen` for rules that appear again
3. Add new rules detected from this analysis
4. Remove rules with `count < 2` that haven't been seen in 30+ days (stale rules)
5. Maximum 50 rules total (keep most recently seen)

**For each detected pattern, create a rule:**

```json
{
  "rule": "[concise description of the preference]",
  "category": "[code_style|interaction|technical|project_norm|general]",
  "source": "auto",
  "count": [number of times detected],
  "lastSeen": "[ISO 8601 date of most recent occurrence]"
}
```

### Step 5: Write Updated Taste File

Write the merged rules to `workspace/.disclaude/taste.json`:

```
Use Write tool to save workspace/.disclaude/taste.json
```

### Step 6: Send Summary to User

Send a summary using `send_user_feedback`:

```json
{
  "content": "[Markdown summary of detected taste rules]",
  "format": "text",
  "chatId": "[The chatId from context]"
}
```

---

## Commands

### `/taste` or `/taste list`

Show current taste rules:

1. Read `workspace/.disclaude/taste.json`
2. If empty: "还没有收集到用户偏好。随着我们的交流，我会自动学习你的偏好。"
3. If has rules: Display grouped by category with statistics

**Output format:**

```markdown
## 🎯 用户偏好总结

**最后更新**: 2026-04-14
**规则数量**: 8 条

### 代码风格
- 使用 const/let，禁止 var（被纠正 3 次）
- 函数名使用 camelCase（被纠正 2 次）
- 优先 TypeScript（来自 CLAUDE.md）

### 交互偏好
- 回复简洁，先结论后分析（被纠正 2 次）
- 使用中文 commit message（被纠正 3 次）

### 技术选择
- 使用 pnpm 而非 npm（被纠正 2 次）
```

### `/taste update`

Re-analyze chat logs and update taste rules (run Steps 1-6 above).

### `/taste edit`

Edit taste rules manually. Read the current file, ask the user what they want to change, and write the updated file.

### `/taste reset`

Clear all taste rules:
1. Write empty rules array to `workspace/.disclaude/taste.json`
2. Confirm to user: "已清空所有用户偏好。"

---

## Category Labels

| Category | Chinese Label | Description |
|----------|--------------|-------------|
| `code_style` | 代码风格 | Naming, formatting, language preferences |
| `interaction` | 交互偏好 | Communication style, response format |
| `technical` | 技术选择 | Framework, tool, library preferences |
| `project_norm` | 项目规范 | Directory structure, naming conventions |
| `general` | 其他偏好 | Unclassified preferences |

---

## Integration with CLAUDE.md

When analyzing chat logs, also check for existing CLAUDE.md files:

1. `CLAUDE.md` in the workspace root
2. `workspace/projects/*/CLAUDE.md` for project-specific rules

Extract explicit rules from these files as `source: "claude_md"` rules. These have lower count (0) but serve as authoritative references.

---

## Integration with Daily Chat Review

This skill can be invoked by the `daily-chat-review` skill during automated daily analysis. When invoked in this context:

1. Focus on the most recent day's logs
2. Only add new rules (don't re-analyze everything)
3. Update counts for existing patterns
4. Send a brief summary (not a full report)

---

## DO NOT

- ❌ Create rules from one-time requests (minimum 2 occurrences)
- ❌ Store sensitive information (API keys, passwords, personal data)
- ❌ Override explicit CLAUDE.md rules with contradictory auto-detected rules
- ❌ Create more than 50 rules (truncate oldest first)
- ❌ Include rules the user explicitly rejected
- ❌ Send taste reports to wrong chatId
