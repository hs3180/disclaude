---
name: "Agent Framework Benchmark"
cron: "0 10 * * 1"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# Agent Framework Benchmark — Weekly Scheduled Execution

Every Monday at 10:00, use the `agent-benchmark` skill to analyze the past week's chat history and generate an agent performance evaluation report.

## Execution

Use the `agent-benchmark` skill to evaluate agent performance across all chats.

Parameters:
- **Analysis period**: Last 7 days (default)
- **Report target chatId**: {controlChannelChatId}

### Pre-check

Before running the full analysis, check if there is sufficient data:

```bash
# Count log files from the past 7 days
find workspace/logs/ -name "*.md" -mtime -7 | wc -l
```

- If fewer than 3 log files → skip this week (insufficient data), send a brief note explaining why
- If 3+ log files → proceed with full analysis

### Analysis Focus Areas

Each week, rotate the primary focus area to ensure comprehensive coverage over time:

| Week | Primary Focus | Additional Notes |
|------|---------------|------------------|
| Week 1 | Response Efficiency | Focus on round counts and first-response quality |
| Week 2 | Task Completion | Focus on success/abandonment rates |
| Week 3 | User Satisfaction | Focus on positive/negative feedback signals |
| Week 4 | Tool Usage & Errors | Focus on tool selection and error patterns |

While the primary focus gets deeper analysis, all dimensions should still receive basic evaluation every week.

## Installation Instructions

Copy this file to `schedules/agent-benchmark/SCHEDULE.md`, then replace the following placeholders:

| Placeholder | Replace With |
|-------------|-------------|
| `{controlChannelChatId}` | The actual chatId where benchmark reports should be sent |
