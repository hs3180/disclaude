# Research Execution Schedule Template

Template for running research tasks as scheduled tasks with isolated working directories.

**Mechanism**: Research = Schedule task + isolated cwd + state file + progress notification

## Architecture

```
User describes research need
  → Agent creates isolated working directory
  → Schedule task registered (cron trigger)
  → Each tick: Agent reads RESEARCH.md state → executes next step → updates state → pushes progress
  → On completion: renders final report → pushes result card → cleanup
```

## Setup Flow

### Step 1: Create Working Directory

```bash
mkdir -p /data/workspace/research/{research-topic-slug}
```

### Step 2: Initialize RESEARCH.md

Create the state file in the working directory:

```markdown
---
topic: "{Research Topic}"
created: "{date}"
status: "planning"
phase: 1
total_phases: 4
chatId: "{feishu_group_chat_id}"
---

# Research: {Topic}

## Objectives
- {objective_1}
- {objective_2}

## Progress

### Phase 1: Planning [COMPLETED]
- [x] Define research questions
- [x] Identify data sources
- [ ] Define scope

### Phase 2: Data Gathering [PENDING]
- [ ] Source 1: {description}
- [ ] Source 2: {description}

### Phase 3: Analysis [PENDING]
- [ ] Synthesize findings
- [ ] Identify patterns

### Phase 4: Report [PENDING]
- [ ] Render final report
- [ ] Push to Feishu

## Findings

{accumulated findings during research}

## Sources

{collected sources with notes}
```

### Step 3: Create Feishu Discussion Group

Follow the `start-discussion` skill pattern — create group, inject context via `push_to_agent`, record mapping:

```bash
# Create group via lark-cli
lark-cli im +chat-create --name "Research: {topic}" --description "Scheduled research: {topic}" --users "{owner_open_id}"
```

Parse the response to extract the new group's `chatId` (format: `oc_xxx`).

Inject initialization context via `push_to_agent`:

```
push_to_agent(chatId: "{new_group_chatId}", message: "你是一个研究助手。当前研究任务：{topic}。\n\n研究目标：\n- {objective_1}\n- {objective_2}\n\n工作目录：/data/workspace/research/{slug}\n状态文件：RESEARCH.md\n\n每次被触发时，读取 RESEARCH.md 获取当前状态，执行下一个待办步骤，更新状态文件。遇到关键进展或阶段转换时推送进度卡片。")
```

Record mapping (atomic write):

```bash
# Read current mapping
cat /data/workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
# Then update with new entry and write atomically:
echo '{ ... updated JSON with new entry ... }' > /data/workspace/bot-chat-mapping.json.tmp \
  && mv /data/workspace/bot-chat-mapping.json.tmp /data/workspace/bot-chat-mapping.json
```

Mapping entry format:

```json
{
  "research-{slug}": {
    "chatId": "{new_chat_id}",
    "topic": "{topic}",
    "type": "research",
    "workDir": "/data/workspace/research/{slug}",
    "createdAt": "{ISO_timestamp}"
  }
}
```

### Step 4: Register Schedule Task

Create schedule file at the standard location per the `schedule` skill convention:

```bash
SCHEDULE_DIR="${DISCLAUDE_WORKSPACE_DIR:-/data/workspace}/schedules/research-{slug}"
mkdir -p "$SCHEDULE_DIR"
```

Write `SCHEDULE.md` (uppercase, required by schedule skill):

```bash
cat > "$SCHEDULE_DIR/SCHEDULE.md" << 'EOF'
---
name: "Research — {topic}"
cron: "0 */2 * * *"
enabled: true
blocking: true
chatId: "{feishu_group_chat_id}"
---

# Research Task: {topic}

Continue research on {topic}. Read RESEARCH.md state and execute the next pending step.

## Instructions

1. Read `/data/workspace/research/{slug}/RESEARCH.md` to get current state
2. Determine the next pending step based on phase and checklist
3. Execute that step (web search, data analysis, etc.)
4. Update RESEARCH.md with findings and mark step complete
5. Push a progress card to the Feishu group if a phase transition occurred
6. If all phases complete, render the final report using report templates
EOF
```

## Execution Flow (Per Tick)

Each time the schedule triggers, the agent should:

### 1. Read State

```bash
cat /data/workspace/research/{slug}/RESEARCH.md
```

### 2. Determine Next Action

Based on the `status` and unchecked items:

| Status | Action |
|--------|--------|
| `planning` | Finalize objectives, identify sources, set scope |
| `gathering` | Search web, read documents, collect data |
| `analyzing` | Synthesize findings, identify patterns, draw conclusions |
| `reporting` | Render report using template from `report-templates.md` |
| `completed` | Push final card and disable schedule |

### 3. Execute Step

- Limit each tick to **one meaningful step** (one source, one analysis, one section)
- This ensures progress is incremental and resumable
- Avoid trying to complete the entire research in one tick

### 4. Update State

Update RESEARCH.md:
- Check off completed items
- Add findings to the Findings section
- Add sources to the Sources section
- Update `status` field if phase transitioned
- Increment `phase` if all items in current phase are done

### 5. Push Progress (Optional)

Send a progress card to the Feishu group **only** on phase transitions:

```json
{
  "config": { "wide_screen_mode": true },
  "header": { "title": { "content": "Research Progress: {topic}", "tag": "plain_text" }, "template": "blue" },
  "elements": [
    { "tag": "markdown", "content": "**Phase {n}/{total}: {phase_name}**" },
    { "tag": "markdown", "content": "{summary_of_what_was_done}" },
    { "tag": "markdown", "content": "Next: {next_step_description}" }
  ]
}
```

Do NOT push on every minor step — only on meaningful milestones to avoid notification noise.

### 6. Completion

When all phases are done:

1. Render final report using appropriate template from `report-templates.md`
2. Push the report as a file or card to the Feishu group
3. Update RESEARCH.md status to `completed`
4. Disable or remove the schedule task
5. Optionally use `dissolve-group` skill for cleanup (if user agrees)

## State Management Best Practices

### RESEARCH.md Structure

- **Frontmatter**: Machine-readable state (status, phase, timestamps)
- **Progress section**: Checklist of tasks per phase
- **Findings section**: Accumulated raw findings (append-only)
- **Sources section**: Collected references with brief notes

### State Transitions

```
planning → gathering → analyzing → reporting → completed
```

Only advance to the next phase when **all** items in the current phase are checked off.

### Error Handling

If a step fails:
1. Leave the item unchecked
2. Add a note in Findings about the failure
3. Move to the next item (don't block on failures)
4. Mention the failure in the next progress card

## Example: Scheduled Tech Comparison Research

**User request**: "帮我对比一下 React vs Vue 的最新性能数据"

### RESEARCH.md (initial)

```markdown
---
topic: "React vs Vue Performance Comparison"
created: "2026-06-09"
status: "planning"
phase: 1
total_phases: 4
chatId: "oc_xxx"
---

# Research: React vs Vue Performance Comparison

## Objectives
- Compare latest benchmark data (2026)
- Evaluate bundle size, rendering speed, memory usage
- Provide recommendation based on use case

## Progress

### Phase 1: Planning [IN PROGRESS]
- [x] Define research questions
- [x] Identify data sources (official benchmarks, third-party)
- [ ] Define scope (which metrics matter)

### Phase 2: Data Gathering [PENDING]
- [ ] Gather React 19 benchmark data
- [ ] Gather Vue 4 benchmark data
- [ ] Gather bundle size comparisons
- [ ] Gather community adoption trends

### Phase 3: Analysis [PENDING]
- [ ] Compare rendering performance
- [ ] Compare bundle sizes
- [ ] Compare ecosystem maturity

### Phase 4: Report [PENDING]
- [ ] Render comparison report
- [ ] Push to Feishu group

## Findings

## Sources
```

### Schedule Template

File: `${DISCLAUDE_WORKSPACE_DIR:-/data/workspace}/schedules/research-react-vue-perf/SCHEDULE.md`

```markdown
---
name: "Research — React vs Vue Performance"
cron: "0 */2 * * *"
enabled: true
blocking: true
chatId: "oc_xxx"
---

# Research Task: React vs Vue Performance Comparison

Continue research. Read RESEARCH.md state and execute next pending step.

## Instructions

1. Read `/data/workspace/research/react-vue-perf/RESEARCH.md`
2. Execute the next unchecked item in the current phase
3. Update RESEARCH.md with findings
4. Push progress card on phase transitions
5. On completion, render comparison report using report-templates.md
```

## Usage Notes

1. **Working directory isolation**: Each research task gets its own directory under `/data/workspace/research/`
2. **One step per tick**: Don't try to do everything in one execution; let the schedule drive incremental progress
3. **RESEARCH.md is the source of truth**: Always read it first, always update it after
4. **Push sparingly**: Only notify on phase transitions, not every minor step
5. **Clean up**: On completion, disable the schedule and optionally dissolve the Feishu group
