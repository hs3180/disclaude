---
name: research-mode
description: Research mode skill for entering an isolated research workspace. Creates a dedicated research directory with RESEARCH.md state file. Use when user wants to start a research task, deep-dive analysis, or systematic investigation. Keywords: 研究, research, 调研, investigation, 深度分析, deep dive, 研究模式.
allowed-tools: Read, Write, Bash, Glob, Grep, WebSearch
---

# Research Mode

You are entering **Research Mode** — an isolated research workspace for focused investigation.

## When to Activate

Activate this skill when the user:
- Asks to "research" or "investigate" a topic
- Requests a deep-dive analysis
- Wants to systematically gather and synthesize information
- Says keywords like "研究", "调研", "深度分析", "research mode"

## Workflow

### Step 1: Initialize Research Workspace

When starting a new research task:

1. **Determine the research topic** from the user's request
2. **Create the research workspace** by running:
   ```bash
   mkdir -p research/{sanitized-topic-name}/notes research/{sanitized-topic-name}/sources
   ```
3. **Create RESEARCH.md** in the research directory with this template:

```markdown
# Research: {Topic Title}

> Started: {YYYY-MM-DD}
> Status: In Progress

## Objective

{Clear description of what we're researching and why}

## Context

{Background information, prerequisites, or starting assumptions}

## Findings

{Research findings go here — update after each discovery}

## Questions

{Open questions to investigate — update as research progresses}

## Sources

{List of sources consulted — add as you go}

## Conclusion

{Final synthesis — fill in when research is complete}
```

### Step 2: Conduct Research

During research:
- **Stay focused** on the objective defined in RESEARCH.md
- **Update RESEARCH.md** after each significant finding
- **Save artifacts** (data, code snippets, diagrams) to `notes/` or `sources/`
- **Track open questions** and mark them resolved as you find answers

### Step 3: Update RESEARCH.md

After each research interaction, update the relevant sections:

| Section | When to Update |
|---------|---------------|
| **Findings** | After discovering new information |
| **Questions** | When new questions arise or existing ones are answered |
| **Sources** | After consulting a new source |
| **Conclusion** | When research is complete or a phase is done |

### Step 4: Present Results

When research is complete:
1. Update the **Conclusion** section in RESEARCH.md
2. Set status to "Complete" in the header
3. Present a summary to the user with:
   - Key findings
   - Answered questions
   - Remaining uncertainties (if any)
   - Path to the RESEARCH.md file for reference

## Directory Access Guidelines

In Research Mode:
- **Primary workspace**: `research/{topic}/` — all research files go here
- **Notes**: `research/{topic}/notes/` — research notes and artifacts
- **Sources**: `research/{topic}/sources/` — collected source materials
- **RESEARCH.md**: `research/{topic}/RESEARCH.md` — always keep this updated

## Best Practices

1. **One topic per workspace** — don't mix unrelated research in the same directory
2. **Update RESEARCH.md frequently** — it serves as the research state file
3. **Cite sources** — always note where information comes from
4. **Track questions** — use the Questions section as a living TODO list
5. **Be systematic** — follow the research phases: Plan → Gather → Analyze → Synthesize

## Integration with Agentic Research

This skill complements the `agentic-research` skill:
- **research-mode**: Manages workspace, directory structure, and state file
- **agentic-research**: Provides research methodology and quality guidelines

When both are active, follow both sets of guidelines.
