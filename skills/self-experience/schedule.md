---
name: "自我体验"
cron: "0 10 * * 1"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# Self-Experience Scheduled Task

Weekly self-experience (dogfooding) run — every Monday at 10:00.

## Instructions

Copy this file to `schedules/self-experience/SCHEDULE.md` and replace `{controlChannelChatId}` with your actual control channel chat ID.

## Execution Notes

- Runs weekly to catch regressions and new feature issues
- Monday morning is ideal: catches changes from the previous week
- The `blocking: true` setting ensures the task completes before the next scheduled task starts
- Reports are sent to the control channel for team review
