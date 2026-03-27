---
name: research-workflow
description: Interactive agentic research workflow with outline negotiation, progress tracking, and report generation. Use when user wants to start a research project, investigate a topic deeply, or conduct systematic multi-phase analysis. Keywords: 研究流程, research workflow, 深度研究, 系统研究, research project, 交互式研究, 大纲协商.
argument-hint: [research-topic]
allowed-tools: Read, Write, Edit, Bash, WebSearch, mcp__web_reader__*, Task
---

# Research Workflow

You are conducting an **interactive research workflow**. This skill orchestrates a multi-phase research process with user collaboration, progress tracking, and structured output.

## Research Topic

**Topic**: $ARGUMENTS

If `$ARGUMENTS` is empty, ask the user to describe their research topic before proceeding.

---

## Phase 0: Initialization

### 0.1 Parse and Refine the Research Topic

Before starting, clarify the research scope with the user:

1. **Understand intent**: What is the core question or goal?
2. **Identify scope**: What is in-scope and out-of-scope?
3. **Determine depth**: Quick survey vs. deep analysis?
4. **Expected output**: Brief summary, detailed report, or comprehensive analysis?

### 0.2 Create Research Workspace

Create a dedicated directory for this research session:

```bash
mkdir -p "workspace/research/{sanitized-topic-name}"
```

The `{sanitized-topic-name}` should be a URL-safe, lowercase version of the topic (replace spaces with hyphens, remove special characters).

### 0.3 Initialize RESEARCH.md

Create `RESEARCH.md` in the workspace directory using the template below. This file serves as the **single source of truth** for research state throughout the workflow.

```markdown
# Research: {Topic Title}

> **Status**: 🟡 Outline Negotiation
> **Started**: {date}
> **Last Updated**: {date}

## Research Goals

- [ ] {Goal 1}
- [ ] {Goal 2}
- [ ] {Goal 3}

## Research Outline

### Phase 1: {Phase Name}
- **Objective**: ...
- **Sources**: ...
- **Key Questions**:
  - [ ] ...

### Phase 2: {Phase Name}
- **Objective**: ...
- **Sources**: ...
- **Key Questions**:
  - [ ] ...

## Findings

### {Phase 1 Title}
*(To be filled during execution)*

## Pending Questions

- [ ] ...

## Conclusions

*(To be filled after synthesis)*

## Sources

| # | Source | Type | URL | Date |
|---|--------|------|-----|------|
| 1 | ... | ... | ... | ... |

## Change Log

| Date | Phase | Change |
|------|-------|--------|
| {date} | Init | Research started |
```

**IMPORTANT**: Use the `Edit` tool (not `Write`) for all subsequent updates to RESEARCH.md to preserve the full history.

---

## Phase 1: Outline Negotiation

### 1.1 Generate Initial Research Outline

Based on the refined topic, create a structured research outline:

1. **Break down** the research topic into 2-5 research phases
2. **For each phase**, define:
   - Objective: What this phase aims to discover
   - Approach: How to gather information (web search, document reading, data analysis)
   - Expected output: What deliverables this phase produces
   - Dependencies: What needs to be completed first
3. **Identify key sources**: Academic papers, official docs, reputable publications
4. **Estimate effort**: Rough time estimate for each phase

### 1.2 Present Outline to User

Format the outline as a clear, readable table and present it to the user:

```markdown
## 📋 Research Outline: {Topic}

| Phase | Objective | Approach | Est. Time |
|-------|-----------|----------|-----------|
| 1. ... | ... | ... | ~X min |
| 2. ... | ... | ... | ~X min |
| 3. ... | ... | ... | ~X min |

**Total estimated time**: ~X min

**Questions for you**:
1. Does this outline cover what you need?
2. Any phases to add, remove, or reorder?
3. Any specific sources you'd like me to prioritize?
```

### 1.3 Iterate on Outline

**This is a multi-round negotiation process.** Follow these rules:

- **Accept** user feedback gracefully — revise the outline accordingly
- **Explain** your reasoning when you propose a specific structure
- **Push back respectfully** if a suggested change would compromise research quality (explain why)
- **Limit iterations** to a maximum of 3 rounds to avoid infinite refinement loops
- **Finalize** when the user explicitly approves or after 3 rounds (use the latest version)

After finalization:
1. Update RESEARCH.md with the approved outline
2. Update status to `🟡 Executing`
3. Proceed to Phase 2

---

## Phase 2: Research Execution

Execute the research plan phase by phase. Follow these rules for each phase:

### 2.1 Execute Research Phase

For each phase in the outline:

1. **Gather information** using appropriate tools:
   - `WebSearch` for broad topic searches
   - `mcp__web_reader__webReader` for reading specific web pages in detail
   - `Read`/`Grep`/`Glob` for analyzing local files
   - `Task` for delegating sub-research to sub-agents (for complex phases)

2. **Cross-validate** findings:
   - Verify key claims with at least 2 independent sources
   - Document conflicting information
   - Note source reliability and bias

3. **Document findings immediately** in RESEARCH.md:
   - Update the relevant "Findings" section
   - Add new sources to the "Sources" table
   - Mark completed key questions with `[x]`

4. **Check for contradictions or surprises**:
   - If you find information that contradicts the research hypothesis, **pause and notify the user**
   - If you discover something significantly more important than expected, **highlight it**

### 2.2 Progress Checkpoint

After completing each phase, present a brief progress update:

```markdown
## ✅ Phase {N} Complete: {Phase Name}

**Key findings**:
- Finding 1
- Finding 2

**Sources consulted**: X

**Next**: Phase {N+1}: {Next Phase Name}

Would you like to:
1. Continue to the next phase
2. Modify the research direction
3. Dive deeper into any finding
```

### 2.3 Handle User Intervention

The user may intervene at any time during execution. Handle these scenarios:

| User Action | Response |
|-------------|----------|
| "Change direction to X" | Update outline, note the pivot in Change Log, continue |
| "Go deeper on X" | Expand current phase, add sub-questions |
| "Skip this part" | Mark as skipped, move to next phase |
| "What have you found so far?" | Present current findings summary from RESEARCH.md |
| "This doesn't look right" | Verify sources, explain methodology, correct if needed |

**Always update RESEARCH.md** when the research plan changes.

---

## Phase 3: Synthesis & Review

### 3.1 Synthesize Findings

After all phases are complete:

1. **Review all findings** in RESEARCH.md
2. **Cross-reference** across phases for consistency
3. **Identify patterns**, contradictions, and key insights
4. **Draft conclusions** that directly address the research goals

### 3.2 Present Draft Report

Present a structured draft to the user:

```markdown
## 📊 Research Report Draft: {Topic}

### Executive Summary
{2-3 sentence summary of key findings}

### Key Findings
1. **{Finding 1}**: {Description} (Source: ...)
2. **{Finding 2}**: {Description} (Source: ...)
3. **{Finding 3}**: {Description} (Source: ...)

### Conclusions
{Overall conclusions addressing research goals}

### Limitations
{Known limitations and uncertainties}

### Sources
{Numbered source list with URLs}
```

### 3.3 User Review

Ask the user for feedback on the draft:

1. **Accuracy**: Are the findings correct?
2. **Completeness**: Is anything missing?
3. **Clarity**: Is the report easy to understand?
4. **Actionability**: Are the conclusions useful?

Incorporate feedback and finalize the report.

---

## Phase 4: Report Delivery

### 4.1 Select Report Format

Based on the research type and user preference, choose the appropriate format:

| Research Type | Recommended Format | Description |
|---------------|-------------------|-------------|
| Quick Survey | Summary Card | Concise bullet-point summary |
| Technical Analysis | Detailed Report | Full structured report with sources |
| Comparison Study | Comparison Table | Side-by-side comparison matrix |
| Market/Industry Research | Market Brief | Executive summary + key data points |
| Deep Investigation | Comprehensive Report | Full report with methodology, findings, conclusions |

If the user doesn't specify, use **Detailed Report** as default.

### 4.2 Render Final Report

Generate the final report in the chosen format. Include:

1. **Title and metadata** (date, topic, status)
2. **Executive summary**
3. **Structured findings** with source citations
4. **Conclusions and recommendations**
5. **Source list** with URLs
6. **Limitations and confidence levels**

### 4.3 Update RESEARCH.md

Finalize the RESEARCH.md file:

1. Update status to `✅ Complete`
2. Fill in the Conclusions section
3. Add final Change Log entry
4. Ensure all sources are properly documented

### 4.4 Deliver to User

Send the final report to the user. If the research was conducted in a chat platform, format it appropriately for that platform (using interactive cards if available).

---

## Quality Standards

Throughout the workflow, maintain these quality standards:

- ✅ All claims backed by cited sources
- ✅ No fabricated data or mock information
- ✅ Conflicting information acknowledged and documented
- ✅ Source reliability assessed
- ✅ Research objectives explicitly addressed
- ✅ Limitations clearly stated
- ✅ RESEARCH.md kept up-to-date at all times

## RESEARCH.md Status Reference

Use these status indicators in RESEARCH.md:

| Status | Emoji | Meaning |
|--------|-------|---------|
| Outline Negotiation | 🟡 | Collaborating on research plan |
| Executing | 🔵 | Research in progress |
| Paused | ⏸️ | Waiting for user input |
| Review | 🟠 | Draft report under review |
| Complete | ✅ | Research finished |

## Infrastructure Notes

This skill is designed to work with the disclaude platform's research infrastructure:

- **Research Mode** (`/research`): Enables dedicated workspace isolation and SOUL injection for research tasks
- **RESEARCH.md**: Structured state file for persistent research tracking across sessions
- **Temp Chat**: Supports collaborative research discussions in dedicated temporary chats

When running in a disclaude environment with these features available, the workflow automatically integrates with them. In standalone mode, the workflow uses local file-based state management.
