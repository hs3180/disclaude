---
name: agentic-research
description: "Agentic research best practices. Use when performing research tasks, data analysis, literature review, or any task requiring systematic information gathering and synthesis. Keywords: 研究, 研究, research, 分析, analysis, 调研, investigation."
---

# Agentic Research Guide

## Context

You are performing a research task. This guide helps you avoid common pitfalls and follow best practices for systematic, high-quality research.

## Common Pitfalls to Avoid

### 1. Data Source Issues

**Problems to avoid:**
- Using unreliable or unverified data sources
- Switching to "convenient" sources after user guidance
- Forgetting user-specified source preferences

**Best practices:**
- Always prefer authoritative sources (official docs, peer-reviewed papers, established databases)
- When user specifies a data source, stick to it throughout the task
- If you must use alternative sources, explain why and get user confirmation
- Document your source choices for transparency

```
Good: "Based on the official API documentation..."
Bad: "I found this on a random blog..."
```

### 2. Data Processing Issues

**Problems to avoid:**
- Skipping data cleaning steps
- Using inappropriate data formats or precision
- Substituting real data with mock data without explicit permission
- Processing raw data without preprocessing, leading to poor performance

**Best practices:**
- Always clean and validate data before analysis
- Choose appropriate data types and precision levels
- NEVER use mock/simulated data unless explicitly requested
- Preprocess data for optimal performance (filter, aggregate, transform as needed)

```
Good: "I'll clean the data by removing null values and normalizing dates..."
Bad: "I'll use some sample data to demonstrate..."
```

### 3. Research Direction Issues

**Problems to avoid:**
- Spending excessive time on irrelevant details
- Missing obvious conclusions or insights
- Ignoring visualization insights
- Oscillating between approaches based on minor feedback

**Best practices:**
- Start with clear research objectives
- Prioritize analysis that directly addresses the core question
- Pay attention to obvious patterns and conclusions
- When interpreting visualizations, describe what you see before drawing conclusions
- When receiving feedback, understand the intent before making changes

**Research objective checklist:**
- [ ] What is the main question to answer?
- [ ] What are the key metrics or outcomes?
- [ ] What is the scope and what is out of scope?
- [ ] What level of detail is needed?

### 4. Learning and Knowledge Issues

**Problems to avoid:**
- Not reviewing relevant existing research or documentation
- Forgetting previously established context
- Failing to provide supporting evidence
- Repeating the same mistakes

**Best practices:**
- Before starting, review relevant docs, issues, or prior work
- Maintain context throughout the research session
- Always cite sources and provide evidence for claims
- When corrected, update your understanding for future reference

### 5. Knowledge Confusion Issues

**Problems to avoid:**
- Mixing up similar but distinct concepts
- Repeating errors after verbal correction
- Inconsistent application of learned knowledge

**Best practices:**
- When dealing with similar concepts, explicitly compare and contrast them
- If corrected, restate the correct understanding to confirm
- For complex topics, create structured summaries or comparison tables

### 6. Skill Overload Awareness

**Context:** Having too many skills can lead to poor skill selection, like an inexperienced waiter struggling with an oversized menu.

**Best practices:**
- Trust the skill matching system - relevant skills will be suggested
- Focus on the task at hand rather than exploring all available capabilities
- If a skill seems relevant, use it; don't second-guess the matching

## Research Workflow

### Phase 1: Planning

1. **Clarify objectives**: What question(s) need to be answered?
2. **Identify data sources**: Where will information come from?
3. **Define scope**: What's in scope and out of scope?
4. **Estimate effort**: Is this a quick lookup or deep analysis?

### Phase 2: Execution

1. **Gather data** from approved sources
2. **Clean and validate** data quality
3. **Analyze** using appropriate methods
4. **Document** findings with evidence

### Phase 3: Synthesis

1. **Summarize** key findings
2. **Visualize** if helpful (charts, tables, diagrams)
3. **Cite sources** for all claims
4. **Highlight limitations** and uncertainties

### Phase 4: Review

1. **Check completeness**: Did you answer the main question?
2. **Verify accuracy**: Are sources cited correctly?
3. **Get feedback**: Does the output meet user needs?

## Handling User Feedback During Research

> Issue #4017. Research runs in a separate execution chat driven by scheduled runs on the schedule base (cron + chatId; the loop system is deprecated, see #4430). User feedback — corrections, intent changes, scope or source-preference adjustments — originates in the **initial conversation** with the user, *not* in the research execution chat. The execution chat carries progress updates and delivery; it is not a feedback channel. Feedback reaches the running research **only through the shared state file** — never by reading the initial conversation's messages.

The mechanism is a safe, append-only write to `RESEARCH.md`: the conversation Agent captures feedback there, and the research Agent re-reads it at the start of each run. There is **no cross-conversation message reading and no `sourceChatId` wiring** — the earlier cross-conversation approach was reviewed and rejected (see closed PR #4030); the agreed direction is direct, safe `RESEARCH.md` modification.

### Write side — capture feedback into RESEARCH.md (conversation Agent)

When the user gives feedback in the initial conversation while research is running, **directly modify `RESEARCH.md`** in the research workdir:

1. Append a timestamped entry to a dedicated `## User Feedback` section (create the section if it does not yet exist). Keep it **append-only** — never rewrite or delete prior entries.
2. One feedback point per entry. In 1–3 lines state **what** the user wants changed (intent / correction / new constraint / source preference) and, if given, **why**. Quote the user's words where it removes ambiguity.
3. Do not pre-filter or editorialize — capture the user's intent faithfully; the research Agent decides whether and how to apply it.

Example entry:

- **2026-08-04 14:05 — narrow scope**: User said "Drop the EU comparison; focus only on US and China." → limit geography to US + China; EU section out of scope.

Only the `## User Feedback` section is written from the conversation side; the research Agent owns every other section of `RESEARCH.md`.

### Read side — let feedback adjust direction (research Agent)

At the **start of each scheduled run**, re-read the `## User Feedback` section of `RESEARCH.md` alongside the rest of the state file. Treat new entries as **suggestive, not authoritative**: evaluate each against the current findings before acting, acknowledge what you applied in the next progress card, and do not retroactively rewrite already-delivered sections unless the feedback explicitly asks for it.

When writing `RESEARCH.md` back at the end of a run, carry the `## User Feedback` section forward **verbatim** — it is written from the conversation side and is not yours to rewrite or drop, so a feedback entry appended mid-run is never lost.

### Properties

- **Non-blocking.** Writing feedback never interrupts the running execution; it takes effect at the next run's read. Never block a run waiting for feedback.
- **Single channel.** The `## User Feedback` section of `RESEARCH.md` is the only feedback path into the running research — the user should not need to repeat themselves in the execution chat.

## Quality Checklist

Before completing a research task:

- [ ] All data from approved/reliable sources
- [ ] No mock data used without explicit permission
- [ ] Research objectives clearly addressed
- [ ] Evidence provided for key claims
- [ ] Sources properly cited
- [ ] Limitations acknowledged
- [ ] User can reproduce the findings

## Example: Good vs Bad Research

### Bad Example
```
"I searched for information about X and found some articles.
The data shows Y is better than Z. Here's my analysis..."
```
Problems: No sources cited, no evidence, vague data reference.

### Good Example
```
"Based on the official documentation from [source] and the
research paper [citation], I analyzed the differences between
Y and Z. Key findings:

1. **Performance**: Y showed 40% better latency (source: benchmark report)
2. **Cost**: Z is 20% cheaper for small workloads (source: pricing page)
3. **Limitation**: This analysis is based on synthetic benchmarks;
   real-world results may vary.

Sources:
- [1] Official docs: https://...
- [2] Research paper: https://...
"
```

## Report Templates

When producing research output, use the structured templates in the [report templates reference](./report-templates.md) as a starting point. Available templates:

| Template | Best For |
|----------|----------|
| Executive Summary | Quick overviews, decision-making |
| Full Report | Comprehensive analysis, documentation |
| Comparison | Evaluating 2+ options side-by-side |
| Annotated Bibliography | Literature review, source catalog |

Select the template that best matches the user's needs. Adapt sections as needed — templates are guidelines, not rigid requirements.

## Report Rendering Workflow

When research reaches the delivery phase, follow this workflow to produce the final report.

### Step 1: Select Template

Use this decision tree to pick the right template from [report-templates.md](./report-templates.md):

| User Intent | Template | Why |
|-------------|----------|-----|
| "Give me a quick answer" or decision support | Executive Summary | Bottom-line upfront, concise |
| "I need a thorough analysis" or formal documentation | Full Report | Structured evidence, methodology |
| "Compare X vs Y" or "Which is better?" | Comparison | Side-by-side criteria analysis |
| "Find all sources about X" or literature survey | Annotated Bibliography | Source-centric with critical evaluation |

When in doubt, ask the user which format they prefer. Default to **Executive Summary** for short tasks, **Full Report** for deep research.

### Step 2: Populate Template

1. **Map findings to sections**: Each key finding goes into the appropriate template section (Findings, Analysis, Criteria, etc.)
2. **Fill all placeholders**: Replace every `{placeholder}` with concrete data. Remove any placeholder you cannot fill and note it as a limitation.
3. **Adapt language**: Produce the report in the user's language (match the conversation language). Template structure stays the same; content language adapts.
4. **Cite sources**: Every factual claim must reference its source. Use `[N]` notation linking to the Sources section.

### Step 3: Validate Before Delivery

Check the report against this list before sending:

- [ ] All `{placeholder}` fields replaced with actual content
- [ ] Every claim has a source citation
- [ ] The report directly answers the original research question
- [ ] Limitations and caveats are explicitly stated
- [ ] Language matches user's conversation language
- [ ] No mock or fabricated data included

### Step 4: Deliver Report

Choose the delivery format based on context:

| Format | When to Use | How |
|--------|-------------|-----|
| **Feishu doc** | Long reports (>500 words), user may want to share/edit | Create doc via `lark-cli docs +create`, paste rendered Markdown |
| **Group message card** | Short summaries, Executive Summary format | Send as structured card via `send_card` |
| **Markdown file** | Multi-step research output, archival | Write to `STATE.md` or `RESEARCH.md` in the research workdir |

For scheduled-task-driven research, deliver via Feishu doc and post a summary card in both the research group and the source chat.

## Research Canvas (Human-AI Shared Outline)

Issue #4016 (Sub-E). For research spanning multiple steps, create a Feishu doc as
the **Research Canvas** — a shared space where the user can edit the research
outline (add/remove questions, adjust priorities, annotate) and the Agent
publishes progress. It complements the `RESEARCH.md` feedback channel: feedback
is *captured* in `RESEARCH.md`, while the outline is *co-edited* on the Canvas.

The full template, lark-cli commands, and sync/failure rules live in the
[canvas template reference](./canvas-template.md). In short:

- **Create** on the first scheduled run — this is step 3 of [Per-step behavior](#per-step-behavior) when no `canvasUrl` exists yet (`lark-cli docs +create` from the template), store the URL as `canvasUrl` in `RESEARCH.md`, and post the link
  to the user (grant access — bot docs are not user-visible by default).
- **Sync at the start of every run** (`docs +fetch`): merge user Canvas edits
  into `RESEARCH.md` first (user edits win on conflict; annotations append to
  the `## User Feedback` section), then push progress to the Canvas
  (`docs +update` targeted edits — never whole-doc overwrites).
- **Never block a run on the Canvas** — a sync failure is logged in `STATE.md`
  and the research continues.
- **RESEARCH.md stays the state source**; the Canvas is its editable projection.

## Research Discipline (Scheduled-Task Driven)

Research runs in **one mode** (Issue #4006): every step is driven the same way — a scheduled task fires (per its `SCHEDULE.md` cron) and routes the step to the chat's persistent agent. Whether the user happens to be at the keyboard for a given step changes nothing: do not wait for them, do not branch behavior on their presence. Treat the guidance below as applying to **every** step.

### Key decision points (where research drifts)

No one is watching each step by default, so catch these explicitly and record the decision in `STATE.md`:

| Decision point | What to check | If uncertain (safe default) |
|----------------|---------------|-----------------------------------|
| **Goal clarification** | Does this step still serve the user's original question? | Keep the original goal; note the ambiguity. Do not silently redefine scope. |
| **Data source selection** | Is the source authoritative, and the one the user asked for? | Prefer the user-specified source; only switch with a recorded reason. |
| **Analysis direction** | Is the analysis drifting away from the core ask? | Re-anchor to the original question; flag the drift in `STATE.md`. |
| **Conclusion validity** | Does the conclusion actually answer what was asked? | State explicitly what is answered vs. out-of-scope. |

### Per-step behavior

At the **start of every step**, before doing anything else:

1. **Read the latest state** — re-read `STATE.md` and `RESEARCH.md` from the workdir. Do not rely on memory of a previous step; state files are the source of truth and may have changed since your last turn.
2. **Check for user feedback** — new entries in the `## User Feedback` section of `RESEARCH.md` (appended by the conversation Agent, per #4017) are the single feedback channel. Read that section as part of re-reading the state files, treat entries as suggestive rather than authoritative, and let them adjust this step's direction.
3. **Create or sync the Research Canvas** — if a `canvasUrl` exists in `RESEARCH.md`, follow the [canvas template](./canvas-template.md) sync flow: fetch the doc, merge user edits back into `RESEARCH.md` (user edits win), then publish this step's progress to the Canvas. A sync failure never blocks the step. If no `canvasUrl` exists **and** this research spans multiple steps (first run), **create** the Canvas now (Sub-E.1): instantiate the [canvas template](./canvas-template.md) from the plan in `RESEARCH.md`, run its create flow (`lark-cli docs +create`), store the doc URL as `canvasUrl` in `RESEARCH.md`, and post the link to the user. A create failure never blocks the step — log it and retry next run. Single-step research skips the Canvas entirely.
4. **Carry the thread forward** — write the step's outcome, open questions, and intended next action back into `STATE.md` so the next step picks up cleanly.
5. **Be decisive, flag uncertainty** — make the most reasonable decision and proceed rather than stalling. Record what you decided and what you are unsure about (`⚠️ uncertain: …`) so the user can correct it later. Do **not** block the whole research on a question the user has not answered yet.
6. **Deliver incrementally** — write the shared artifact to a Feishu doc and post a summary card in both the research group and the source chat, so the user sees progress whenever they look.

## Related

- Issue #1021: Research task common complaints and improvements
- Issue #963: GLM-5 infinite loop (extreme case of source selection issues)
- Issue #1339: Agentic Research interactive workflow (parent feature)
- Issue #4006: Research discipline guidance for scheduled runs (the Research Discipline section above)
- Issue #4016: Research Canvas (the Research Canvas section above)
