---
name: "Weekly Self-Dogfooding"
cron: "0 11 * * 1"
enabled: false
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
createdAt: "2026-04-26T00:00:00.000Z"
---

# Weekly Self-Dogfooding

每周一 11:00 自动体验最新版本功能，模拟用户交互，生成质量反馈报告。

**Related**: #1560

## Configuration

**Important**: Before using, replace `chatId` with the actual Feishu Chat ID and set `enabled` to `true`.

## Execution Steps

### 1. Inventory Available Features

```bash
ls skills/*/SKILL.md
```

Read each skill's name and description to build a feature inventory.

### 2. Check Recent Changes

Read `CHANGELOG.md` (first 100 lines) to identify:
- Newly added features
- Recently changed features
- Bug fixes that might need verification

### 3. Select Features to Test

Select 2-3 features based on:
- **Priority**: New or recently changed features first
- **Variety**: Choose from different categories (skills, schedules, core features)
- **Avoid**: Do not select self-dogfooding itself (prevent recursion)

### 4. Simulate User Interactions

For each selected feature:

1. **Choose a persona** (rotate: new user, power user, non-technical, frustrated)
2. **Generate test scenarios** (3-5 per feature):
   - Happy path: normal usage
   - Edge case: unusual inputs
   - Error recovery: what happens after failure
   - Cross-feature: interaction with other features
3. **Evaluate**: Would a real user be satisfied?

### 5. Generate Report

```markdown
## Dogfooding Report

**Date**: [Current date]
**Version**: [From package.json]
**Persona**: [Selected persona]
**Features Tested**: [List]

### Summary

| Dimension | Score | Notes |
|-----------|-------|-------|
| Response Quality | [1-5] | ... |
| Error Handling | [1-5] | ... |
| User Experience | [1-5] | ... |
| Feature Completeness | [1-5] | ... |

### [Feature Name]
#### Scenarios
- Scenario 1: [PASS/WARN/FAIL] - [notes]
- Scenario 2: [PASS/WARN/FAIL] - [notes]

### Overall Findings
- Highlights: ...
- Issues: ...
- Suggestions: ...
```

### 6. Send Report

```
send_user_feedback({
  content: [report content],
  format: "text",
  chatId: [configured chatId]
})
```

## Error Handling

1. If no skills are found, report "No skills available for testing"
2. If CHANGELOG.md is missing, proceed with available feature inventory only
3. If `send_user_feedback` fails, retry once
4. If a feature cannot be evaluated (missing dependencies), note it in the report

## Acceptance Criteria (from Issue #1560)

- [x] Periodic trigger mechanism (via scheduler)
- [x] Personified simulation (multiple user personas)
- [x] Unscripted scenarios (LLM-driven selection and testing)
- [x] Structured feedback report with scores and suggestions
- [x] Feedback delivery via send_user_feedback

## Related

- **Issue**: #1560 (Self-dogfooding feature)
- **Pattern**: Same skill + schedule approach as `daily-chat-review` and `daily-soul-question`
