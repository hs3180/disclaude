---
name: discussion-focus
description: Discussion focus skill for start_discussion tool integration. Provides personality-driven focus keeping for group discussions via SOUL.md injection. Use when user says keywords like "讨论焦点", "discussion focus", "保持聚焦", "start discussion".
allowed-tools: Read, Glob, Grep, Bash, WebSearch
---

# Discussion Focus

Maintain focused group discussions through personality-driven SOUL.md injection.

## When to Use This Skill

**Use this skill for:**
- Setting up discussion focus for `start_discussion` tool invocations
- Creating or updating discussion SOUL profiles
- Configuring per-task SOUL.md for scheduled discussion tasks

**Keywords that trigger this skill**: "讨论焦点", "discussion focus", "保持聚焦", "start discussion", "讨论人格"

## How It Works

### SOUL.md System Integration

This skill leverages the SOUL.md personality injection system (Issue #1315) to keep discussions focused without complex偏离检测 algorithms. The key mechanism:

1. **SOUL Profile** (`souls/discussion.md`) — Defines the discussion personality
2. **Per-task injection** — Each discussion task loads the SOUL profile via `soul:` frontmatter
3. **Natural focus** — The agent maintains focus through personality, not rule enforcement

### Usage with Scheduled Tasks

To create a discussion task with focus-keeping personality, add `soul:` to the schedule frontmatter:

```markdown
---
name: "Daily Standup Discussion"
cron: "0 9 * * 1-5"
soul: "souls/discussion.md"
---
Discuss yesterday's progress and today's plan with the team.
```

### Usage with start_discussion

When the `start_discussion` MCP tool creates a new chat, the agent automatically:
1. Loads the discussion SOUL profile if configured
2. Injects it as a system prompt append
3. The agent's personality naturally keeps the discussion focused

## SOUL Profile Content

The discussion SOUL profile (`souls/discussion.md`) defines:

| Principle | Description |
|-----------|-------------|
| **Stay on topic** | The initial question is the north star |
| **Genuine helpfulness** | No performative filler phrases |
| **Gentle redirection** | Acknowledge tangents, then guide back |
| **Depth over breadth** | Thorough exploration over surface skimming |
| **Progress summaries** | Periodically summarize to maintain focus |

## Customization

Users can customize the discussion personality by editing `souls/discussion.md` in the workspace directory. The file supports:

- **Markdown formatting** for readability
- **Natural language instructions** for personality definition
- **Section-based organization** (Core Truths, Boundaries, etc.)

### Global SOUL.md Configuration

For system-wide personality injection, configure in `disclaude.config.yaml`:

```yaml
soul:
  path: souls/discussion.md
  maxSize: 32768  # 32KB default
```

## Acceptance Criteria

- [x] Discussion SOUL Profile defined (`souls/discussion.md`)
- [x] SOUL.md infrastructure supports per-task soul injection via `soul:` frontmatter
- [x] Discussion maintains focus through personality, not complex detection
- [x] Compatible with `start_discussion` tool integration
- [x] Does not affect normal multi-turn discussions (only injected when configured)
