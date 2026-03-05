# Scheduled Tasks

This directory contains scheduled task definitions.

## Usage

1. Copy an example from `examples/schedules/` to this directory
2. Rename the file (e.g., `my-task.md`)
3. Edit the YAML frontmatter:
   - Replace `chatId` with your actual Feishu chat ID
   - Set `enabled: true` to activate the task
4. The scheduler will automatically load and execute the task

## Example

```bash
cp examples/schedules/recommend-analysis.example.md workspace/schedules/recommend-analysis.md
```

Then edit `workspace/schedules/recommend-analysis.md`:
```yaml
---
name: "智能推荐分析"
cron: "0 3 * * *"
enabled: true
chatId: "oc_your_actual_chat_id"
---
```

## Available Examples

- `recommend-analysis.example.md` - Daily analysis of interaction patterns
- `pr-scanner.example.md` - Periodic PR scanning and notifications
