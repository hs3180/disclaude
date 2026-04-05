---
name: research-state
description: RESEARCH.md research state file management. Use when starting a new research task, updating research progress, or archiving completed research. Automatically maintains structured research state files in workspace/research/{topic}/RESEARCH.md. Keywords: RESEARCH.md, research state, 研究状态, 研究进展, research progress, research file, 研究归档.
---

# RESEARCH.md Research State File Management

## Overview

This skill provides a structured approach to managing research state through `RESEARCH.md` files. Similar to how `CLAUDE.md` provides persistent project context, `RESEARCH.md` provides persistent research session state.

## When to Use

**Auto-invoked when:**
- Starting a new research task or investigation
- The agent is performing systematic research with multiple steps
- User asks to review research progress or findings

**Manual invocation:** `/research-state [action]`

| Action | Description |
|--------|-------------|
| (none) | Initialize a new RESEARCH.md for current research topic |
| `update` | Update existing RESEARCH.md with latest findings |
| `archive` | Archive completed research with conclusion summary |
| `status` | Display current research status from RESEARCH.md |

## File Location

```
workspace/research/{topic}/RESEARCH.md
```

- `{topic}` should be a short, descriptive slug (e.g., `agent-frameworks`, `tcc-audio`)
- Use lowercase, hyphen-separated format
- If no topic is specified, generate one from the research objective

## RESEARCH.md Template

When initializing a new research, create the file with this structure:

```markdown
# {Research Topic}

> {Brief description of research goal and background}

**Created**: {ISO 8601 date}
**Status**: 🔄 In Progress

---

## Research Objectives

- [ ] {Objective 1}
- [ ] {Objective 2}

---

## Findings

### {Finding Title}
- **Source**: {URL or reference}
- **Key Content**: {Summary of finding}
- **Added**: {date}

---

## Pending Questions

- [ ] {Question 1}
- [ ] {Question 2}

---

## Conclusions

_(Fill in when research is complete)_

---

## Resources

- [{Resource Name}]({URL})
```

## Phase 1: Initialization

When starting a new research task:

1. **Create the research directory**:
   ```bash
   mkdir -p workspace/research/{topic}
   ```

2. **Generate the RESEARCH.md file**:
   - Set the title to the research topic
   - Fill the description based on the user's research goal
   - Populate research objectives from the user's stated goals
   - Set status to `🔄 In Progress`

3. **Check for existing research**:
   - Before creating a new RESEARCH.md, check if `workspace/research/` contains related directories
   - If a related file exists, ask the user whether to continue from it or start fresh

## Phase 2: Auto-Update Rules

After each research interaction, update the RESEARCH.md file following these rules:

### Adding New Findings

When a new finding is discovered:
- Add it to the `## Findings` section
- Include source URL/reference
- Write a concise summary (2-3 sentences)
- Include the date added

### Managing Questions

| Situation | Action |
|-----------|--------|
| New question arises | Add to `## Pending Questions` with `[ ]` checkbox |
| Question is answered | Move from `## Pending Questions` to `## Findings` with a summary |
| Question is no longer relevant | Remove from `## Pending Questions` |

### Updating Objectives

- When an objective is met, change `[ ]` to `[x]`
- If objectives change during research, update the list with a note

### Status Updates

| Status | Indicator | When to Use |
|--------|-----------|-------------|
| In Progress | `🔄 In Progress` | Active research |
| Blocked | `⚠️ Blocked` | Waiting on external input |
| Complete | `✅ Complete` | All objectives met, conclusions written |

## Phase 3: Archival

When research is complete:

1. **Write conclusions** in the `## Conclusions` section:
   - Summary of key findings (3-5 bullet points)
   - Answer to the original research question
   - Any remaining uncertainties or follow-up suggestions

2. **Update status** to `✅ Complete`

3. **Clean up**:
   - Ensure all objectives are checked
   - Remove empty sections
   - Verify all sources are properly cited

4. **Optional archive** (if user requests):
   ```bash
   mv workspace/research/{topic} workspace/research/_archived/{topic}-{date}
   ```

## Update Guidelines

### DO

- ✅ Update RESEARCH.md after every significant research step
- ✅ Keep findings concise (2-3 sentences each)
- ✅ Always include source references
- ✅ Use consistent formatting throughout the file
- ✅ Update the status indicator when research state changes

### DO NOT

- ❌ Delete findings or questions (archive instead)
- ❌ Write overly long entries (keep findings scannable)
- ❌ Skip updating after a research interaction
- ❌ Modify the file structure (sections must remain consistent)

## Integration Notes

- **Research Mode (#1709)**: When Research Mode is active, RESEARCH.md is automatically initialized when entering a research project
- **Agentic Research (#1339)**: The agentic-research skill uses RESEARCH.md for state tracking during multi-step research workflows
- **CLAUDE.md**: RESEARCH.md complements CLAUDE.md — CLAUDE.md provides project-level context, RESEARCH.md provides session-level research state

## Example: Completed RESEARCH.md

```markdown
# Agent Framework Comparison

> Compare Claude Agent SDK, LangChain, and AutoGen for building AI agent systems

**Created**: 2026-04-01T10:00:00Z
**Status**: ✅ Complete

---

## Research Objectives

- [x] Compare architecture approaches
- [x] Evaluate tool integration patterns
- [x] Assess production readiness

---

## Findings

### Claude Agent SDK - Streaming Architecture
- **Source**: https://docs.anthropic.com/en/docs/agent-sdk
- **Key Content**: Uses AsyncGenerator-based streaming for real-time input/output. Per-chatId agent instances with message queuing.
- **Added**: 2026-04-01

### LangChain - Chain-based Composition
- **Source**: https://python.langchain.com/docs/
- **Key Content**: Uses LCEL chains for composable workflows. Rich ecosystem but higher abstraction overhead.
- **Added**: 2026-04-01

---

## Pending Questions

_(All questions resolved)_

---

## Conclusions

- Claude Agent SDK is best for real-time conversational agents with streaming needs
- LangChain excels in complex multi-step workflows with extensive integrations
- AutoGen is最适合多 agent 协作场景
- For this project, Claude Agent SDK is the clear choice given streaming requirements

---

## Resources

- [Claude Agent SDK](https://docs.anthropic.com/en/docs/agent-sdk)
- [LangChain](https://python.langchain.com/docs/)
- [AutoGen](https://microsoft.github.io/autogen/)
```
