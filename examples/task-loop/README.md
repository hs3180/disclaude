# Task While-Loop Templates

Scripts that drive an agent to execute multi-step tasks by repeatedly pushing system messages via `disclaude-push` CLI.

**Related:** #3812 — Task While-Loop via script + system message
**Depends on:** #3808 — `disclaude-push` CLI

## Concept

Instead of implementing a complex state machine inside the agent, the loop control lives in an external script:

```
External Script (while loop)
  │
  ├── Check completion condition (file system)
  ├── Push next instruction via disclaude-push
  └── Wait for agent to process
```

The agent only needs to execute a single step per iteration.

## Files

| File | Description |
|------|-------------|
| `task-loop.sh` | Bash template — portable, minimal dependencies |
| `task-loop.mjs` | Node.js template — better error handling, async |

## Quick Start

### Bash

```bash
# Copy and customize
cp examples/task-loop/task-loop.sh ./my-task.sh

# Run
./my-task.sh --chat-id "oc_xxx" --task-id "task-001"
```

### Node.js

```bash
# Copy and customize
cp examples/task-loop/task-loop.mjs ./my-task.mjs

# Run
node my-task.mjs --chat-id "oc_xxx" --task-id "task-001"
```

## Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--chat-id` | Yes | — | Target chat ID to push messages to |
| `--task-id` | Yes | — | Task identifier for state tracking |
| `--max-iter` | No | 10 | Maximum iterations before timeout |
| `--interval` | No | 30 | Seconds between iterations |
| `--done-file` | No | `tasks/<task-id>/done` | Path to completion marker file |

## Completion Detection

The default mechanism is file-based: when the agent creates the done file (e.g., `tasks/task-001/done`), the loop detects it on the next iteration and sends a final summary request.

You can customize the completion condition by modifying the `check_done` function (bash) or `checkDone` function (Node.js).

## Prerequisites

- `disclaude-push` CLI must be installed and in PATH
- Primary Node must be running (the CLI connects via IPC socket)
