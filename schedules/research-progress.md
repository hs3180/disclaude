---
name: "Research Progress Monitor"
cron: "0 */30 * * * *"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Research Progress Monitor

Periodically checks for active research sessions and sends progress updates to users.

## Configuration

- **Check interval**: Every 30 minutes
- **Research directory**: `workspace/research/`

## Execution Steps

### 1. Scan for active research sessions

```bash
# Find all RESEARCH.md files with status "executing"
find workspace/research/ -name "RESEARCH.md" -exec grep -l "Status:.*executing" {} \;
```

If no active sessions found, exit silently.

### 2. Read each active RESEARCH.md

For each active session, read the RESEARCH.md file to extract:
- Research title
- Current phase and progress
- Last updated timestamp
- Key findings so far
- Open questions

### 3. Check staleness

Compare the `Updated` timestamp with the current time:
- If updated within the last 30 minutes → skip (recently active)
- If updated more than 30 minutes ago → send progress check

### 4. Send progress update

For stale sessions, send a progress update to the research owner:

```markdown
## 📊 Research Progress Check

**Research**: {Title}
**Last updated**: {time since last update}
**Current phase**: {Phase name}

**Progress**:
{Progress table from RESEARCH.md}

**Key findings so far**:
- {Finding 1}
- {Finding 2}

**Open questions**: {count remaining}

---
研究仍在进行中。如需调整方向或取消，请回复。
```

### 5. Check for expired sessions

If a session has not been updated for more than 24 hours:
- Mark the RESEARCH.md status as `paused`
- Notify the owner that the research has been automatically paused
- Owner can resume by invoking `/agentic-research` again

## State Management

Research sessions are self-managed via RESEARCH.md files. No external state tracking needed.

| RESEARCH.md Status | Meaning | Action |
|--------------------|---------|--------|
| `planning` | Outline negotiation in progress | Skip (user is actively engaged) |
| `executing` | Research in progress | Check staleness, send updates |
| `review` | Report being prepared | Skip (near completion) |
| `completed` | Research finished | Skip |
| `paused` | Research paused | Skip |

## Error Handling

- If RESEARCH.md is malformed → Log warning, skip this session
- If workspace/research/ directory doesn't exist → Exit silently (no research sessions yet)
- If owner cannot be determined → Skip notification

## Dependencies

- Workspace directory structure (managed by agentic-research skill)
- RESEARCH.md format (defined in agentic-research skill)

## Notes

- This schedule is **disabled by default** (`enabled: false`)
- Enable it when there are active research sessions that need monitoring
- The check interval (30 minutes) balances responsiveness with noise reduction
