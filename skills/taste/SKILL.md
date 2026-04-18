---
name: taste
description: Auto-summarize user taste and preferences to avoid repeated corrections. Use when user says keywords like "taste", "偏好", "我的习惯", "用户偏好", "user preference", "纠正记录", or when analyzing chat history for preference patterns. Integrates with daily-chat-review to detect correction patterns.
argument-hint: [list|analyze|edit|reset]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, send_user_feedback
---

# Taste Manager — User Preference Auto-Summarization

Manage user taste profiles to avoid repeated corrections across sessions.

## Context Variables

When invoked, you receive:
- **Chat ID**: Feishu chat ID (from "**Chat ID:** xxx")
- **Message ID**: Message ID (from "**Message ID:** xxx")

---

## Storage

Taste data is stored in `workspace/taste.yaml`:

```yaml
# workspace/taste.yaml
# Auto-generated user preference profile
# Last updated: 2026-04-18

taste:
  code_style:
    - rule: "使用 const/let，禁止 var"
      source: auto
      count: 3
      last_seen: "2026-04-14"
      examples:
        - "不要用 var，用 const/let"
    - rule: "函数名使用 camelCase"
      source: auto
      count: 2
      last_seen: "2026-04-15"
      examples:
        - "函数名用 camelCase 不要用 snake_case"
  interaction:
    - rule: "回复简洁，先结论后分析"
      source: auto
      count: 2
      last_seen: "2026-04-16"
      examples:
        - "回复要简洁，不要啰嗦"
  technical:
    - rule: "优先使用 TypeScript 而非 JavaScript"
      source: auto
      count: 1
      last_seen: "2026-04-17"
      examples:
        - "用 TypeScript 不要用 JavaScript"
```

---

## Commands

### `/taste list` (default)

Display all current taste rules grouped by category.

**Steps**:
1. Read `workspace/taste.yaml` using Read tool
2. If file doesn't exist, report "No taste profile found. Use `/taste analyze` to generate one."
3. If exists, format and display:

```markdown
## 🎯 Your Taste Profile

**Last Updated**: {date}
**Total Rules**: {count}

### 💻 Code Style
- 使用 const/let，禁止 var _(被纠正 3 次)_
- 函数名使用 camelCase _(被纠正 2 次)_

### 💬 Interaction
- 回复简洁，先结论后分析 _(被纠正 2 次)_

### 🔧 Technical
- 优先使用 TypeScript _(来自 CLAUDE.md)_
```

4. Send the result via `send_user_feedback` with format "text"

### `/taste analyze`

Analyze chat history to detect user preferences and correction patterns.

**Steps**:

1. **Read chat logs**:
   - Use Glob to find log files: `workspace/logs/**/*.md`
   - Read recent logs (last 14 days recommended)
   - If no logs found, report: "No chat logs found for analysis."

2. **Detect correction patterns**:

   Search for user correction signals:

   | Signal | Pattern | Category |
   |--------|---------|----------|
   | Direct correction | "不要...", "别...", "不应该...", "不要用..." | code_style |
   | Preference statement | "我喜欢...", "我偏好...", "用 xxx 而不是..." | code_style/technical |
   | Style correction | "简洁点", "太啰嗦了", "先说结论" | interaction |
   | Technical preference | "用 TypeScript", "用 pnpm", "用 vitest" | technical |
   | Negative feedback | "不对", "错了", "不是这样的" | (context-dependent) |

3. **Extract taste rules**:
   - Group similar corrections together
   - Count occurrences (2+ same pattern = taste rule)
   - Extract the general rule from specific instances
   - Record the last seen date and example

4. **Merge with existing taste**:
   - Read existing `workspace/taste.yaml` if present
   - Merge new findings (increment counts for existing rules)
   - Add new rules discovered
   - Write updated `workspace/taste.yaml`

5. **Report findings**:

```markdown
## 🔍 Taste Analysis Report

**Analyzed**: {N} chat logs ({date range})
**New Rules Found**: {count}
**Updated Rules**: {count}

### New Discoveries
- 🆕 使用 const/let，禁止 var (detected 3 times)
- 🆕 回复简洁，先结论后分析 (detected 2 times)

### Updated Rules
- 📈 函数名使用 camelCase (3 → 5 times)

### Taste profile saved to workspace/taste.yaml
Use `/taste list` to view full profile.
```

6. Send the report via `send_user_feedback` with format "text"

### `/taste edit`

Edit the taste profile manually.

**Steps**:
1. Read current `workspace/taste.yaml`
2. If not exists, report "No taste profile. Use `/taste analyze` first."
3. Display current profile and prompt:
   ```
   Current taste profile loaded. Please tell me what you'd like to change:
   - Add a rule: "添加规则：xxx"
   - Remove a rule: "删除规则：xxx"
   - Modify a rule: "修改规则：xxx 改为 yyy"
   ```
4. Parse user's edit instruction
5. Update `workspace/taste.yaml`
6. Confirm the change

### `/taste reset`

Clear all auto-detected taste rules.

**Steps**:
1. Read current `workspace/taste.yaml`
2. Ask for confirmation: "确认清空所有偏好记录？(yes/no)"
3. If confirmed, remove the file or reset to empty:
   ```yaml
   taste: {}
   ```
4. Report: "✅ Taste profile cleared."

---

## Detection Algorithm

### Correction Signal Detection

When analyzing chat logs, look for these patterns in user messages:

#### Level 1 — Explicit Corrections (High Confidence)
User directly corrects Agent's output:
- "不要用 var，用 const/let"
- "不是这样的，应该是..."
- "改一下，函数名用 camelCase"

→ **Action**: Extract as taste rule immediately (count = 1, needs 2+ to activate)

#### Level 2 — Repeated Preferences (Medium Confidence)
User states the same preference across multiple sessions:
- Session 1: "用 TypeScript"
- Session 3: "我更习惯 TypeScript"
- Session 5: "TypeScript 优先"

→ **Action**: Merge as single taste rule with count = 3

#### Level 3 — Implicit Patterns (Low Confidence)
User consistently modifies Agent output in the same way:
- Always changes `var` → `const` in code review
- Always asks for "简洁一点"

→ **Action**: Flag for review, don't auto-add (future enhancement)

### Rule Extraction

When extracting a taste rule from a correction:

1. **Generalize** the specific correction:
   - "这个文件不要用 var" → "禁止使用 var，用 const/let"
   - "回复太长了" → "回复简洁"
   - "不要用 npm，用 pnpm" → "使用 pnpm 而非 npm"

2. **Categorize** the rule:
   - Code formatting → `code_style`
   - Interaction style → `interaction`
   - Tech stack / tool choice → `technical`

3. **Record** metadata:
   - `source`: "auto" (detected from chat) or "manual" (user added)
   - `count`: number of times this pattern was detected
   - `last_seen`: date of most recent occurrence
   - `examples`: list of actual user messages (max 3)

### Merging Rules

When the same pattern is detected again:

1. Find existing rule with same category and similar content
2. Increment `count`
3. Update `last_seen`
4. Add new example (if fewer than 3)
5. If count >= 2: Rule is "active" and should be included in context

---

## Taste Injection into Agent Context

When taste rules are active (count >= 2), they should be formatted for Agent context injection.

### Format for CLAUDE.md Integration

The taste skill can append a "User Taste" section to the project's CLAUDE.md:

```markdown
## User Taste (auto-learned preferences)

> ⚠️ This section is auto-generated by the taste skill. Do not edit manually.
> Use `/taste` commands to manage.

- 💻 **代码风格**: 使用 const/let，禁止 var (被纠正 3 次)
- 💻 **代码风格**: 函数名使用 camelCase (被纠正 2 次)
- 💬 **交互偏好**: 回复简洁，先结论后分析 (被纠正 2 次)
- 🔧 **技术选择**: 优先使用 TypeScript (来自用户偏好)

<!-- taste:end -->
```

### When to Inject

Taste should be injected:
1. When Agent starts a new conversation (read taste.yaml)
2. When `/taste analyze` discovers new active rules
3. When user explicitly requests via `/taste inject`

---

## Integration with daily-chat-review

The daily-chat-review skill can trigger taste analysis by:
1. When detecting "Manual Corrections" pattern (2+ occurrences)
2. Recommending `/taste analyze` in the report
3. Including taste summary in the daily report

---

## Checklist

- [ ] Read chat log files from workspace/logs/
- [ ] Detect correction patterns (2+ occurrences)
- [ ] Extract and generalize taste rules
- [ ] Categorize into code_style / interaction / technical
- [ ] Merge with existing taste.yaml
- [ ] Send formatted report via send_user_feedback

---

## DO NOT

- Auto-inject taste without user confirmation
- Add rules from a single occurrence (wait for 2+)
- Override explicit CLAUDE.md instructions
- Include sensitive or personal information in taste rules
- Delete taste.yaml without user confirmation
