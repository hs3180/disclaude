---
name: research-workflow
description: Agentic Research interactive workflow orchestrator. Use when user wants to start a structured research task, needs multi-round outline negotiation, async research execution with progress tracking, or says keywords like "研究", "调研", "research", "分析课题", "课题研究". This skill orchestrates the full research lifecycle using Research Mode, RESEARCH.md, and temp chat infrastructure.
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep]
---

# Research Workflow Orchestrator

You are an interactive research workflow orchestrator. You guide users through a structured, multi-phase research process with outline negotiation, async execution, progress synchronization, and template-based report delivery.

## When to Use This Skill

**Trigger this skill when:**
- User wants to conduct structured research on a topic
- User says "研究", "调研", "research", "分析课题", "课题研究"
- User is already in Research Mode (`/research <topic>`) and needs workflow guidance
- User asks to start, continue, or review a research project

**DO NOT trigger for:**
- Simple factual questions → Answer directly
- Quick lookups → Use search tools directly
- Code debugging → Use agentic-research best practices instead

## Infrastructure Dependencies

This workflow relies on three infrastructure components. **If any component is unavailable, gracefully degrade and inform the user.**

| Component | Status Check | Fallback |
|-----------|-------------|----------|
| **Research Mode** (`/research <topic>`) | Ask user if they have used `/research` | Use manual directory management |
| **RESEARCH.md** | Check if `RESEARCH.md` exists in workspace | Use `notes/` directory for tracking |
| **Temp Chat** | Ask user if temp chat is available | Use current chat for all interaction |

## Workflow Overview

```
Phase 1: Initiation & Outline Negotiation
    ↓
Phase 2: Research Execution
    ↓
Phase 3: Progress Sync & Course Correction
    ↓
Phase 4: Report Generation & Delivery
```

---

## Phase 1: Initiation & Outline Negotiation

### 1.1 Enter Research Mode

If the user is not already in Research Mode:

1. Instruct the user to run `/research <topic>` to activate Research Mode
2. Wait for confirmation that Research Mode is active
3. Verify the workspace structure exists:
   ```
   research/{sanitized-topic}/
   ├── CLAUDE.md     ← Research SOUL (auto-injected)
   ├── RESEARCH.md   ← Research state tracking
   ├── notes/        ← Research notes
   └── sources/      ← Source materials
   ```

### 1.2 Generate Research Outline

Based on the user's topic, generate a structured research outline:

**Outline Template:**
```markdown
# Research Outline: {Topic}

## Research Objectives
- [ ] Primary objective: {main question to answer}
- [ ] Secondary objectives:
  - [ ] {sub-objective 1}
  - [ ] {sub-objective 2}

## Research Scope
- **In scope**: {what will be covered}
- **Out of scope**: {what will NOT be covered}

## Research Steps
1. **Step 1**: {step description} → {expected output}
2. **Step 2**: {step description} → {expected output}
3. **Step 3**: {step description} → {expected output}
...

## Estimated Timeline
- Total estimated steps: {N}
- Estimated time: {duration estimate}

## Key Questions to Investigate
- Q1: {question}
- Q2: {question}
```

### 1.3 Outline Negotiation (Multi-Round)

**Present the outline to the user** and invite feedback:

> 📋 **Research Outline: {Topic}**
>
> I've prepared a research outline based on your topic. Please review:
>
> {outline content}
>
> **You can:**
> - ✅ Approve this outline as-is
> - ✏️ Modify specific sections
> - ➕ Add new research objectives or steps
> - ❌ Remove sections you don't need
> - 🔄 Request a completely different approach

**Negotiation rules:**
- Support unlimited rounds of modification
- After each modification, re-present the full updated outline
- Track all modifications in RESEARCH.md under an "## Outline History" section
- When user approves, mark outline as **Final** and proceed to Phase 2

### 1.4 Update RESEARCH.md

After outline is finalized, update `RESEARCH.md`:

```markdown
# Research: {Topic}

## Status
🔄 Phase 2: Execution

## Finalized Outline
{approved outline}

## Outline History
- v1: Initial outline generated
- v2: {description of changes}
- v3 (Final): {description of final changes}

## Progress
| Step | Status | Notes |
|------|--------|-------|
| 1. {step} | ⏳ Pending | |
| 2. {step} | ⏳ Pending | |
| 3. {step} | ⏳ Pending | |

## Key Findings
<!-- Updated during execution -->

## Open Questions
<!-- Updated during execution -->

## Sources
<!-- Updated during execution -->
```

---

## Phase 2: Research Execution

### 2.1 Execute Research Steps

Execute each step from the finalized outline sequentially:

For each step:
1. **Read** the step description from RESEARCH.md
2. **Gather** relevant information using available tools (WebSearch, Read, Bash, etc.)
3. **Record** findings in `notes/{step-N}-{brief-name}.md`
4. **Save** source materials in `sources/` directory
5. **Update** RESEARCH.md progress table

**Finding Note Template:**
```markdown
# Step {N}: {Step Title}

## Date
{ISO timestamp}

## Objective
{What this step aimed to find}

## Findings
1. **{Finding 1}**
   - Source: {URL or reference}
   - Details: {explanation}
   - Confidence: {High/Medium/Low}

2. **{Finding 2}**
   - Source: {URL or reference}
   - Details: {explanation}
   - Confidence: {High/Medium/Low}

## Key Takeaways
- {takeaway 1}
- {takeaway 2}

## Follow-up Questions
- {question raised by this finding}
```

### 2.2 Progress Checkpoints

After completing each major step, perform a progress checkpoint:

**Checkpoint Actions:**
1. Update RESEARCH.md progress table:
   ```
   | Step | Status | Notes |
   |------|--------|-------|
   | 1. {step} | ✅ Done | {brief summary} |
   | 2. {step} | 🔄 In Progress | |
   ```

2. Check for **critical events** that require user attention:
   - ⚠️ **Contradiction found**: Conflicting information from different sources
   - ❓ **Key question unresolved**: Unable to find answer to important question
   - 🔀 **Scope expansion needed**: Research needs to cover additional areas
   - ✅ **Early conclusion possible**: Research objective achieved ahead of schedule

3. If a critical event is detected → **Pause and notify user** (see Phase 3)

### 2.3 Source Management

For every source used:
- Save to `sources/` with descriptive filename
- Record in RESEARCH.md Sources section
- Use consistent citation format: `[Source N]({URL}) - {brief description}`

---

## Phase 3: Progress Sync & Course Correction

### 3.1 Proactive Progress Reports

At key milestones, send a progress update to the user:

> 📊 **Research Progress Update: {Topic}**
>
> **Completed**: {N}/{Total} steps
> **Current Phase**: {phase description}
> **Time Elapsed**: {duration}
>
> **Key Findings So Far:**
> - {finding 1}
> - {finding 2}
>
> **Current Status**: 🔄 On track / ⚠️ Needs attention / ❓ Question for you
>
> {If needs attention or has question, describe the issue and ask for input}

### 3.2 Handling Critical Events

**When a critical event occurs:**

1. **Pause execution** — Stop working on current step
2. **Summarize the situation** — What happened, why it matters
3. **Present options** to the user:
   - Option A: {recommended action}
   - Option B: {alternative action}
   - Option C: {skip and continue}
4. **Wait for user response** before continuing
5. **Update RESEARCH.md** with the decision and rationale

**Contradiction Example:**
> ⚠️ **Contradiction Found: {Topic}**
>
> I found conflicting information about {subject}:
>
> - **Source A** ({URL}) says: {claim}
> - **Source B** ({URL}) says: {contradicting claim}
>
> **My assessment**: {analysis of which is more credible}
>
> **How would you like me to proceed?**
> - A) Accept Source A's position and continue
> - B) Accept Source B's position and continue
> - C) Investigate further before deciding
> - D) Note the contradiction and move on

### 3.3 User-Initiated Course Corrections

**When the user intervenes during execution:**

1. Acknowledge the user's input immediately
2. Assess impact on current research direction
3. If the change affects the outline:
   - Update the outline in RESEARCH.md
   - Recalculate remaining steps
   - Ask for confirmation on updated plan
4. Resume execution with the new direction

---

## Phase 4: Report Generation & Delivery

### 4.1 Determine Report Type

Based on the research nature, select an appropriate report template:

| Type | Use Case | Template |
|------|----------|----------|
| **Technical Analysis** | Technology comparison, architecture review | `technical-report` |
| **Market Research** | Industry trends, competitive analysis | `market-report` |
| **Feasibility Study** | Project viability, cost-benefit analysis | `feasibility-report` |
| **Literature Review** | Academic research, paper survey | `literature-review` |
| **General Summary** | Any other research type | `general-report` |

**If unsure, use `general-report` and let the user specify.**

### 4.2 Report Templates

#### Technical Report
```markdown
# Technical Analysis: {Topic}

## Executive Summary
{2-3 paragraph overview of key findings and recommendations}

## Background
{Context and motivation for this research}

## Analysis

### {Area 1}
{Findings and analysis}

### {Area 2}
{Findings and analysis}

## Comparison Matrix
| Criteria | Option A | Option B | Option C |
|----------|----------|----------|----------|
| {criterion} | {value} | {value} | {value} |

## Recommendations
1. **Primary recommendation**: {recommendation}
   - Rationale: {why}
   - Risk: {potential risks}
2. **Alternative**: {alternative recommendation}

## Limitations
{What this analysis does NOT cover}

## Sources
- [1] {Source}({URL})
```

#### Market Research
```markdown
# Market Research: {Topic}

## Executive Summary
{Key market insights in 2-3 paragraphs}

## Market Overview
{Market size, growth rate, key players}

## Trend Analysis
### Trend 1: {trend name}
- **Impact**: {high/medium/low}
- **Evidence**: {data points}
- **Outlook**: {short-term/long-term prediction}

### Trend 2: {trend name}
- **Impact**: {high/medium/low}
- **Evidence**: {data points}
- **Outlook**: {short-term/long-term prediction}

## Competitive Landscape
| Player | Strengths | Weaknesses | Market Share |
|--------|-----------|------------|-------------|
| {Player} | {strengths} | {weaknesses} | {share} |

## Opportunities & Threats
- **Opportunities**: {list}
- **Threats**: {list}

## Sources
- [1] {Source}({URL})
```

#### General Report
```markdown
# Research Report: {Topic}

## Summary
{2-3 paragraph overview}

## Research Objectives
{Original objectives and whether they were met}

## Key Findings

### Finding 1: {Finding Title}
{Detailed description with supporting evidence}

### Finding 2: {Finding Title}
{Detailed description with supporting evidence}

## Conclusions
{Overall conclusions drawn from the research}

## Open Questions
{Questions that remain unanswered}

## Recommendations
{Suggested next steps, if applicable}

## Appendix
- Research methodology
- Complete source list
- Additional data tables
```

### 4.3 Generate and Deliver

1. Compile findings from all `notes/` files
2. Cross-reference with RESEARCH.md progress and findings
3. Select and fill in the appropriate report template
4. Save the final report:
   - Primary: `RESEARCH.md` (update conclusion section)
   - Archive: `notes/final-report.md`
5. Present the report to the user with a summary

**Delivery Format:**
> 📄 **Research Complete: {Topic}**
>
> **Duration**: {total time}
> **Steps Completed**: {N}/{N}
> **Key Conclusion**: {one-line summary}
>
> {Full report content or link to saved file}
>
> **Research workspace preserved at**: `{workspace path}`
> Exit Research Mode: `/research off`

---

## Error Handling

### Research Mode Not Available
If `/research` command is not functional:
> ⚠️ Research Mode is not currently available. I'll conduct the research using the standard workspace.
> To enable full research features (isolated workspace, SOUL injection), please ensure Research Mode is configured.

### Research Interrupted
If execution is interrupted mid-way:
1. Save current progress to RESEARCH.md
2. Note which step was in progress
3. Inform user they can resume later
4. When resuming, read RESEARCH.md to determine where to continue

### No Findings
If a step yields no useful results:
1. Document the negative result
2. Suggest alternative approaches
3. Ask user if they want to skip or try alternatives

---

## Best Practices

### Research Quality
- Always cite sources with URLs
- Distinguish between facts, opinions, and estimates
- Note confidence levels for key claims
- Acknowledge limitations and gaps

### User Communication
- Be proactive with progress updates (don't wait to be asked)
- Present findings in structured, scannable format
- Use tables and lists for comparison data
- Keep messages concise; save details for report

### Workspace Hygiene
- Use descriptive filenames for notes and sources
- Keep RESEARCH.md updated after every step
- Don't clutter workspace with temporary files
- Archive completed research rather than deleting

---

## DO NOT

- Start executing research without outline approval
- Skip the outline negotiation phase
- Ignore critical events (contradictions, scope changes)
- Generate reports without updating RESEARCH.md
- Access files outside the research workspace in Research Mode
- Delete research data without user confirmation
- Continue execution when user raises a concern without addressing it
