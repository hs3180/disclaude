---
name: loop
description: "Loop — autonomous task execution via Loop Runner. Creates a work environment, sets up a Feishu group, and starts a loop that repeatedly pushes instructions to an agent. Use when the user wants autonomous task execution, iterative coding, or any multi-step task that benefits from a loop pattern. Keywords: 'loop task', '循环任务', 'autonomous loop', 'ralph loop', '循环执行', 'loop', '自主执行'."
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# Loop — Autonomous Task Execution

Initiates a Loop execution: prepares a work directory, creates a Feishu group for the agent, and starts a loop via `loop_start` that repeatedly pushes an instruction to the agent.

**适用于**: 自主执行多步任务、迭代开发、长时间运行的研究任务 | **不适用于**: 单次对话、需要实时交互的任务

## Single Responsibility

- ✅ Parse user requirements and extract task parameters
- ✅ Create a work directory for loop state
- ✅ Create a Feishu group for the loop agent
- ✅ Start the loop via `loop_start` MCP tool
- ✅ Record mapping and confirm to user
- ❌ DO NOT execute the task yourself — the loop agent handles it
- ❌ DO NOT wait for loop completion — return immediately after setup
- ❌ DO NOT manage loop lifecycle (stop/status) — use `loop_stop` and `loop_status` directly

## Workflow

### Step 1: Parse Requirements

From the user's message, extract:

| Parameter | Source | Default |
|-----------|--------|---------|
| **Task description** | User message | Required |
| **maxSteps** | User specifies or infer from complexity | 10 |
| **maxDuration** | User specifies (e.g., "2 hours") | 7200000 (2h) |
| **stepIntervalMs** | Rarely needed | 30000 (30s) |

Generate a filesystem-safe slug from the task description:

```bash
# Example: "Refactor authentication module" → "refactor-authentication-module"
SLUG=$(echo "$TASK_DESC" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
```

### Step 2: Create Work Directory

```bash
WORK_DIR="${DISCLAUDE_WORKSPACE_DIR:-$HOME/workspace}/loop-${SLUG}"
mkdir -p "$WORK_DIR"

# If directory exists, append numeric suffix
if [ -d "$WORK_DIR" ]; then
  N=1
  while [ -d "${WORK_DIR}-${N}" ]; do ((N++)); done
  WORK_DIR="${WORK_DIR}-${N}"
  mkdir -p "$WORK_DIR"
fi
```

Create a `LOOP.md` in the work directory:

```markdown
# Loop: {task description}

## Configuration
- **Max Steps**: {maxSteps}
- **Max Duration**: {maxDuration}ms ({human readable})
- **Step Interval**: {stepIntervalMs}ms
- **Started**: {ISO timestamp}

## Status
- **State**: running
- **Current Step**: 0
```

### Step 3: Create Feishu Group

Create a dedicated Feishu group for the loop agent:

```bash
lark-cli im +chat-create --name "Loop: {topic}" --users "{sender_open_id}"
```

Parse the response to extract the `chatId` (format: `oc_xxx`).

If `lark-cli` fails, report the error and **do not proceed**:

```bash
if ! command -v lark-cli &>/dev/null; then
  echo "ERROR: lark-cli not found in PATH. Cannot create loop group."
  return 1
fi
```

### Step 4: Start the Loop

Call `loop_start` MCP tool:

```
loop_start(
  chatId: "{new group chatId}",
  prompt: "{instruction pushed each step}",
  maxSteps: {maxSteps},
  maxDurationMs: {maxDurationMs},
  stepIntervalMs: {stepIntervalMs}
)
```

The prompt should instruct the agent to:
1. Read `LOOP.md` and `RESEARCH.md` (if any) for current state
2. Execute one coherent unit of work
3. Update state files with progress
4. Check for user feedback and adjust if needed

### Step 5: Record Mapping and Confirm

Record the mapping in `bot-chat-mapping.json`:

```bash
# Read existing mappings
MAPPINGS=$(cat "${DISCLAUDE_WORKSPACE_DIR}/bot-chat-mapping.json" 2>/dev/null || echo '{}')

# Add new mapping (using jq if available, or manual JSON editing)
echo "$MAPPINGS" | jq --arg chat "$CHAT_ID" --arg loop "$LOOP_ID" --arg dir "$WORK_DIR" \
  '.[$chat] = {loopId: $loop, workDir: $dir, type: "loop"}' \
  > "${DISCLAUDE_WORKSPACE_DIR}/bot-chat-mapping.json"
```

Send confirmation to the source chat:

```
Loop started for: {task description}
- Loop ID: {loopId}
- Group: {group name}
- Max steps: {maxSteps}
- Max duration: {human readable duration}

The agent will work autonomously. Use loop_status to check progress, loop_stop to cancel.
```

## Error Handling

| Error | Action |
|-------|--------|
| `lark-cli` not in PATH | Report error, stop |
| Work directory exists | Append numeric suffix |
| Group creation fails | Do not proceed, report to source chat |
| `loop_start` fails | Report to source chat |
| Mapping write fails | Non-critical warning, continue |

## User Controls

After initialization, the user can:

- **`loop_status(loopId)`** — Check current progress
- **`loop_stop(loopId)`** — Cancel the running loop
- **Write feedback to RESEARCH.md** — The loop agent will pick it up on the next step

## Reference

- `skills/start-discussion/SKILL.md` — Similar group creation + push_to_agent pattern
- `skills/agentic-research/SKILL.md` — Loop-driven research behavior guide
- #4039 — Loop System parent issue
- #4063 — Phase 0: Loop Runner
