---
name: "Dogfood Self-Experience"
cron: "0 14 * * 1,3,5"
enabled: false
blocking: true
---

Please execute the dogfood skill for a self-experience session.

Requirements:
1. Randomly select a simulation scenario category
2. Simulate at least 3 user interactions
3. Record all observations
4. Generate a structured report
5. Send the report using send_user_feedback

Note:
- Vary the scenario each time (use day_of_month % 8 as category index)
- Focus on discovering real issues, not just confirming things work
- Be honest about problems found
