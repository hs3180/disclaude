---
name: research-mode
description: Research Mode - 独立研究空间，包含 SOUL 行为规范、工作目录切换和 Skill 套装管理
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - WebSearch
  - Task
---

# Research Mode Skill

## Overview

Research Mode provides an isolated research space by switching three dimensions:
- **SOUL**: Research-specific behavior norms
- **CWD**: Dedicated workspace directory (`workspace/research/{topic}/`)
- **Skills**: Research-relevant skill subset (Phase 2)

## Activation

Use the `/research` command:

```
/research <topic>    # Enter research mode
/research off        # Exit research mode
/research            # Show current status
```

## Directory Structure

When Research Mode is activated, a workspace is created at:
```
workspace/research/{topic}/
  ├── CLAUDE.md      # Research SOUL (auto-injected)
  ├── RESEARCH.md    # Research state file (if using research-manager)
  ├── notes/         # Research notes and artifacts
  └── sources/       # Collected source materials
```

## Research SOUL (CLAUDE.md)

The CLAUDE.md file in the research workspace contains behavior norms that are
automatically loaded by the SDK via `settingSources: ['project']`. This provides:

### Core Behaviors
- Systematic investigation and evidence gathering
- Documentation of findings with source references
- Objectivity — present multiple perspectives
- Explicit tracking of open questions

### Directory Conventions
- `notes/` — Research notes and intermediate artifacts
- `sources/` — Collected source materials and references
- `RESEARCH.md` — Research state file (auto-maintained)

## Integration Notes

### CWD Switching
The Pilot agent checks `ResearchModeManager` when creating SDK options.
If research mode is active, `extra.cwd` is set to the research workspace directory.

### SOUL Injection
The CLAUDE.md in the research workspace is automatically picked up by the SDK
when `settingSources: ['project']` is used and `cwd` points to the research directory.

### Phase 2: Skill Subset
Future enhancement to load only research-relevant skills:
- `agentic-research` — Systematic research workflow
- `site-miner` — Website information extraction
- `web-search` (via tool) — Web search capabilities

## Related Issues
- Issue #1709: Research Mode (this issue)
- Issue #1710: RESEARCH.md research state file
- Issue #1707: Original issue (closed, split into #1709 + #1710)
