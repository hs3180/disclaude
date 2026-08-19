# Research Canvas Template (Feishu Doc)

Reference file for the Research Canvas — the human-AI shared editing space for the
research outline (Issue #4016, Sub-E.4). The Canvas is a Feishu doc created with
`lark-cli docs +create`; the template below is DocxXML passed via `--content`.

> **Architecture note**: the original issue framed Canvas sync around "Loop steps"
> (#4039 / #4040). The loop system is deprecated (#4430); research runs on the
> schedule base (cron + chatId). This template and the sync flow are
> architecture-neutral — "step" below means one scheduled run.

---

## Design principles (from #4016)

| Principle | Meaning |
|-----------|---------|
| **RESEARCH.md is the state source** | Canvas is a *projection* of the outline for co-editing; canonical state (progress, findings, feedback) stays in `RESEARCH.md` |
| **User edits win** | On conflict between Canvas edits and `RESEARCH.md`, the user's Canvas edit takes precedence — merge it back into `RESEARCH.md` |
| **Never block a run** | Canvas sync failure (create/fetch/update) must not block the research step — log it and continue |
| **Existing infra only** | All operations via `lark-cli docs` (+ the `lark-docs` skill for image/attachment handling); no runtime code |

---

## Canvas document template (DocxXML)

Placeholders use `{snake_case}`. Sections map 1:1 onto the outline headings the
research Agent maintains in `RESEARCH.md`, so a reader can cross-check both.

```xml
<title>Research Canvas: {topic}</title>

<callout emoji="🧭" background-color="light-blue">
<p>这是研究 <b>{topic}</b> 的协作画布。你可以直接编辑本页：调整大纲、添加批注、标注优先级。Agent 在每轮运行开始时读取你的修改并同步回 RESEARCH.md。<b>用户编辑优先</b>。</p>
</callout>

<h1>📋 研究大纲</h1>
<checkbox done="{q1_done}">{research_question_1}</checkbox>
<checkbox done="{q2_done}">{research_question_2}</checkbox>
<checkbox done="{qn_done}">{research_question_n}</checkbox>
<p><em>可增删改研究问题；Agent 会按修改后的清单推进。</em></p>

<h1>📊 数据收集</h1>
<table>
  <thead><tr><th><p>来源</p></th><th><p>说明</p></th><th><p>状态</p></th></tr></thead>
  <tbody>
    <tr><td><p>{source_1}</p></td><td><p>{source_1_note}</p></td><td><p>{source_1_status}</p></td></tr>
    <tr><td><p>{source_n}</p></td><td><p>{source_n_note}</p></td><td><p>{source_n_status}</p></td></tr>
  </tbody>
</table>
<p><em>状态用 pending / in-progress / done。</em></p>

<h1>🔍 分析发现</h1>
<p><!-- Agent 每轮运行后追加/更新本节 --></p>

<h1>📝 用户批注（优先级 / 方向调整）</h1>
<p><!-- 用户自由编辑；Agent 读取后合并回 RESEARCH.md 的 User Feedback 节 --></p>

<h1>📚 Sources</h1>
<p><!-- 引用列表，[N] 记法对应报告引用 --></p>
```

Rules when instantiating the template:

- Rows/questions vary with the actual research — add or remove `<checkbox>` /
  `<tr>` blocks to match the plan in `RESEARCH.md`. Do not leave hardcoded
  placeholder rows in a created doc.
- Text content must be XML-escaped (`<` → `&lt;`, `>` → `&gt;`, `&` → `&amp;`).
- Heading levels stay consecutive (`<title>` then `<h1>`s); body headings use
  `<h2>`+ only when nesting under an `<h1>` section.

---

## Create (first scheduled run)

Write the instantiated XML to a file and create the doc, then persist the handle
and tell the user where the Canvas lives:

```bash
lark-cli docs +create --content @canvas.xml --as bot
# → note the doc token from the JSON output
```

The XML already carries the `<title>` tag — do **not** also pass `--title`, or
the doc gets a duplicated title heading. `--content @file` must be a
**relative path** (run from the workdir where `canvas.xml` was written); all
flags below follow the same rule.

1. Store the doc URL in `RESEARCH.md` frontmatter as `canvasUrl` (it is part of
   the research state, so it survives across runs and agents).
2. Post the Canvas link in the research group (and the source chat, if they
   differ) so the user can open and edit it.
3. Grant the user access — bot-created docs are not user-visible by default
   (see the permission snippet in the [`lark-docs` skill](../lark-docs/SKILL.md)).

## Sync (start of every scheduled run)

Read-first: pick up user edits before doing this run's work.

```bash
lark-cli docs +fetch --doc "$CANVAS_URL" --doc-format xml --as bot
```

Then:

1. **Diff against the last synced snapshot** (keep the previous fetch in
   `STATE.md` or alongside it, e.g. `canvas-last.xml`). Detect user changes to
   the outline, sources table, or the 用户批注 section.
2. **Merge user edits into `RESEARCH.md`** — outline changes go to the plan
   section; 批注 entries append to the `## User Feedback` section (same
   append-only contract as conversation-captured feedback, #4017).
3. **Push Agent progress to the Canvas** — update checkbox `done` states,
   source statuses, and the 分析发现 section. Use targeted edits, not whole-doc
   overwrites (which would silently revert concurrent user edits):

```bash
# str_replace for a single inline value (e.g. flip a status)
lark-cli docs +update --doc "$CANVAS_URL" --command str_replace \
  --pattern "{old_text}" --content "{new_text}" --as bot

# block-level replace for a section: locate the heading block first
# (--scope keyword + --detail with-ids returns the block ids), then replace
lark-cli docs +fetch --doc "$CANVAS_URL" --scope keyword --keyword "分析发现" --detail with-ids --as bot
lark-cli docs +update --doc "$CANVAS_URL" --command block_replace \
  --block-id "{block_id}" --content @section.xml --as bot
```

Images/attachments surfaced during research can be inserted with
`docs +media-insert` (see [`lark-docs` skill](../lark-docs/SKILL.md) for the
marker-then-insert workflow).

## Failure handling

- `+fetch` / `+update` failure → record `⚠️ canvas sync failed: {reason}` in
  `STATE.md` and **continue the run**. Never block research on the Canvas.
- Canvas deleted or inaccessible → note it in `STATE.md`; recreate only if the
  user asks (their edits may have been deliberate removal).
- Merge conflicts between concurrent edits → user's Canvas edit wins for
  outline/direction; flag the conflict in `STATE.md` for the user to review.
