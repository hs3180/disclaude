---
name: research-mode
description: Research mode switching - switch to an isolated research space with dedicated SOUL, working directory, and skill subset. Use when user mentions "research mode", "enter research", "start research", "research mode", "research space", or says keywords like "研究模式", "进入研究", "开始研究", "切换研究". Can also be triggered when the agent needs to perform deep, focused research that benefits from isolation.
---

# Research Mode

## Overview

Research Mode switches the agent into an isolated research space by changing three dimensions:

| Dimension | Normal Mode | Research Mode |
|-----------|-------------|---------------|
| SOUL | Default behavior | Research-focused behavior (see soul.md) |
| Working Directory | `workspace/` | `workspace/research/{topic}/` |
| Skill Focus | All skills | Research-relevant subset |

## When to Activate

Activate Research Mode when:
- User explicitly requests research mode (e.g., "进入研究模式")
- A task requires deep, focused investigation over multiple steps
- The research needs its own isolated file space to avoid cluttering the main workspace
- User wants to explore a topic systematically with state tracking

## How to Enter Research Mode

### Step 1: Determine Research Topic

Ask the user for a research topic if not already specified:

```
Please provide a research topic, for example:
- "React Server Components performance"
- "LLM context window optimization techniques"
- "WebSocket vs SSE for real-time apps"
```

### Step 2: Create Research Workspace

```bash
# Create topic-specific research directory
mkdir -p workspace/research/{topic-slug}
```

Use a URL-friendly slug for the topic name (lowercase, hyphens, no spaces).

### Step 3: Load Research SOUL

Read the research SOUL file and adopt its behavioral guidelines:

```bash
cat skills/research-mode/soul.md
```

Apply the research SOUL guidelines for the duration of the research session. This includes:
- Focused, methodical behavior
- Source-first documentation
- Structured note-taking
- No casual conversation behavior

### Step 4: Initialize Research State

Create a RESEARCH.md file in the research directory to track progress:

```markdown
# Research: {Topic Title}

**Status**: Active
**Started**: {date}
**Last Updated**: {date}

## Objectives
- [ ] Primary objective
- [ ] Secondary objective

## Findings
(To be filled during research)

## Sources
(Track all sources used)

## Notes
(Working notes and observations)
```

### Step 5: Confirm Mode Switch

Inform the user that research mode is active:

```
Research Mode activated for: "{topic}"

- Working directory: workspace/research/{topic-slug}/
- Research SOUL: loaded
- State file: RESEARCH.md initialized

All research files will be stored in the dedicated directory.
Use "exit research" or "退出研究" to return to normal mode.
```

## Research Behavior Guidelines

While in Research Mode, follow these principles:

### 1. Directory Isolation
- All research files go into `workspace/research/{topic-slug}/`
- Do NOT create or modify files in the main `workspace/` directory
- Use absolute or relative paths from the research directory

### 2. Focused Skill Usage
Prioritize these research-relevant skills:
- **agentic-research**: Systematic research methodology
- **site-miner**: Website data extraction
- **web-search**: Information gathering
- **skill-creator**: Creating tools for the research if needed

Avoid casual/chat skills:
- ~~bbs-topic-initiator~~
- ~~daily-soul-question~~
- ~~daily-chat-review~~
- ~~schedule-recommend~~

### 3. Documentation Standards
- Cite all sources with URLs
- Record findings in RESEARCH.md
- Keep raw data separate from analysis
- Use structured formats (markdown tables, lists)

### 4. Research Workflow
Follow this workflow for each research session:

1. **Plan**: Define objectives and scope in RESEARCH.md
2. **Gather**: Collect data from authoritative sources
3. **Analyze**: Process and synthesize findings
4. **Document**: Update RESEARCH.md with conclusions
5. **Review**: Verify completeness and accuracy

## How to Exit Research Mode

When the user says "exit research", "退出研究", or the research task is complete:

1. **Finalize RESEARCH.md**:
   - Update status to "Completed" or "Paused"
   - Add final summary
   - Record all sources

2. **Summarize for user**:
   ```
   Research Mode deactivated.

   Summary:
   - Topic: {topic}
   - Duration: {time}
   - Key findings: {brief summary}
   - Research files: workspace/research/{topic-slug}/
   - State: RESEARCH.md (status: completed/paused)

   To resume, say "continue research {topic}".
   ```

3. **Return to normal behavior** - stop applying research SOUL guidelines

## Resuming Research

When the user says "continue research" or "继续研究":

1. Check if a RESEARCH.md exists in any `workspace/research/*/` directory
2. If found, reload the research state and re-enter research mode
3. If multiple research directories exist, ask the user which one to continue
4. If none found, treat as a new research session

## Integration Notes

### With RESEARCH.md State Skill
This skill works independently but complements the `research-state` skill:
- `research-mode` handles mode switching and workspace isolation
- `research-state` provides detailed RESEARCH.md lifecycle management

### With SOUL Pipeline (Future)
When the SOUL loading pipeline is available (via `soul:` frontmatter in schedules or SDK `systemPromptAppend`), the `soul.md` file in this skill directory can be loaded directly as the research SOUL. For now, the agent reads and applies it manually.

### Limitations (Current Implementation)
This is a **behavioral mode switch** implemented as a pure skill:
- SOUL switching is done by reading and following the soul.md guidelines (soft switch)
- Working directory isolation relies on agent discipline (no SDK-level enforcement)
- Skill subset selection is advisory (agent follows recommendations, not hard filtering)

Hard enforcement of these constraints requires TypeScript-level changes, which is planned for Phase 2/3 of the Research Mode feature.

## Related

- Issue #1709: Research Mode feature (this skill implements Phase 1)
- Issue #1710: RESEARCH.md state file (complementary)
- Issue #1707: Original parent issue (split into #1709 + #1710)
