# Research Canvas Document Template

Reference template for creating a Feishu cloud document (Research Canvas) via `lark-cli docs +create`.

The Canvas is a **human-machine shared workspace** that mirrors the RESEARCH.md outline in a collaborative, editable format. RESEARCH.md remains the source of truth; the Canvas is its visual projection.

---

## XML Document Structure

The template below is passed to `lark-cli docs +create --content '...'`:

```xml
<title>Research: {topic}</title>

<h2>📋 研究大纲</h2>
<checkbox checked="false">Define research questions</checkbox>
<checkbox checked="false">Identify data sources</checkbox>
<checkbox checked="false">Define scope</checkbox>
<checkbox checked="false">Plan analysis methods</checkbox>

<h2>📊 数据收集</h2>
<p><em>No data sources yet. Agent and user can add sources here.</em></p>

<h2>🔍 分析发现</h2>
<p><!-- Agent fills in findings as research progresses --></p>

<h2>📝 Sources</h2>
<p><!-- Citation list, auto-populated by Agent --></p>

<h2>💬 协作笔记</h2>
<p><em>用户可在此添加批注、优先级标注或额外指引。Agent 每个 Loop step 开始时会读取此区域。</em></p>
```

---

## Section Reference

| Section | Purpose | Updated By |
|---------|---------|------------|
| `📋 研究大纲` | Research checklist with progress tracking | Agent (auto) + User (can edit/reorder) |
| `📊 数据收集` | Data source inventory and status | Agent (auto) |
| `🔍 分析发现` | Key findings and analysis output | Agent (auto) |
| `📝 Sources` | Full citation list | Agent (auto) |
| `💬 协作笔记` | Free-form user notes and guidance | User (primary), Agent (reads only) |

---

## Synchronization Rules

1. **RESEARCH.md is source of truth**: The Canvas is a read-write projection. When conflict arises, user edits in Canvas take priority and are merged back to RESEARCH.md.
2. **Agent syncs at Loop step start**: Each Loop step begins with `lark-cli docs +fetch` to detect user edits.
3. **Non-blocking**: Canvas sync failures do not block Loop execution. Errors are logged and the step proceeds with RESEARCH.md state.
4. **Checkbox semantics**: `checked="true"` = task complete. Agent updates checkboxes after finishing each outline item.

---

## Usage with lark-cli

```bash
# Create the Canvas document
lark-cli docs +create \
  --title "Research: {topic}" \
  --markdown @canvas-template.xml \
  --as bot

# Store the document token in RESEARCH.md frontmatter
# canvasUrl: https://feishu.cn/docx/{DOC_TOKEN}

# Read user edits at Loop step start
lark-cli docs +fetch --doc "$DOC_TOKEN" --as bot

# Update Canvas after completing a task
lark-cli docs +update \
  --doc "$DOC_TOKEN" \
  --mode str_replace \
  --selection-with-ellipsis '<checkbox checked="false">Define research questions</checkbox>' \
  --content '<checkbox checked="true">Define research questions</checkbox>' \
  --as bot
```

---

## Mapping to RESEARCH.md

| RESEARCH.md Section | Canvas Section | Sync Direction |
|---------------------|----------------|----------------|
| `## Objectives` | `📋 研究大纲` (checkboxes) | Bidirectional |
| `## Data Sources` | `📊 数据收集` | RESEARCH.md → Canvas |
| `## Findings` | `🔍 分析发现` | RESEARCH.md → Canvas |
| `## References` | `📝 Sources` | RESEARCH.md → Canvas |
| _(no equivalent)_ | `💬 协作笔记` | Canvas → RESEARCH.md (appended as notes) |

---

## Design Notes

- **Language**: Template uses emoji + Chinese headers for visual clarity in Feishu. Adapt section content language to match user's locale.
- **Extensibility**: Agent may add new `<checkbox>` items under `📋 研究大纲` as subtasks are identified during research.
- **Minimal initial state**: Template starts with all checkboxes unchecked and placeholder text, allowing the Agent to populate progressively.
