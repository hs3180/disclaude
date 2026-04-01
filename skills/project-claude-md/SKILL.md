---
name: project-claude-md
description: Auto-detect and load CLAUDE.md from development project directory when handling code-related tasks. Use when agent clones, downloads, or enters a project directory for bug fixes, feature implementations, code changes, or any development work. Keywords: CLAUDE.md, project context, development conventions, project setup, coding standards.
---

# Project CLAUDE.md Loader

You are a project context detection specialist. When the agent is working on a **development task** (bug fix, feature implementation, refactoring, code review, etc.) in an **external project directory**, you ensure the project's own `CLAUDE.md` is detected and utilized.

## When to Activate

**Trigger this skill when:**
- The agent has just cloned or downloaded a development project (`git clone`, archive extraction, etc.)
- The agent is about to start making code changes in a project directory
- The agent enters a new project directory for development work

**DO NOT activate when:**
- Working in the agent's own workspace or config directory
- Handling non-code tasks (scheduling, chat, reporting)
- The task is purely conversational or analytical without code changes

## Workflow

### Step 1: Detect Development Task

After the agent locates or clones the target project, check whether the current task involves **code changes**:
- Bug fixes, feature implementations, refactoring → **Yes, proceed**
- Documentation-only changes → **Optional, proceed if convenient**
- Pure analysis or research → **No, skip**

### Step 2: Locate Project CLAUDE.md

Check for `CLAUDE.md` in the project directory:

```bash
# Check the project root directory for CLAUDE.md
ls -la <project-directory>/CLAUDE.md
```

**Search locations (in priority order):**
1. `<project-root>/CLAUDE.md` — Direct project root
2. `<project-root>/.claude/CLAUDE.md` — Claude-specific config directory
3. `<project-root>/claudedocs/CLAUDE.md` — Alternative location

### Step 3: Load and Apply CLAUDE.md Content

If `CLAUDE.md` is found:

1. **Read the full file** using the Read tool
2. **Extract key information:**
   - Build/test/lint commands
   - Project architecture and directory structure
   - Coding conventions and style guidelines
   - Testing requirements
   - Common pitfalls or project-specific rules
3. **Adapt your approach** based on the extracted information:
   - Use the project's preferred build commands (not generic ones)
   - Follow the project's coding conventions
   - Respect the project's testing requirements
   - Be aware of project-specific pitfalls

### Step 4: Graceful Degradation

If `CLAUDE.md` is **NOT found**:

1. Do **NOT** fail or warn the user — this is normal
2. Proceed with standard development practices
3. Look for alternative project documentation:
   - `README.md` — Project overview
   - `CONTRIBUTING.md` — Contribution guidelines
   - `.editorconfig` — Editor settings
   - `package.json` / `pyproject.toml` — Build scripts and metadata
4. Use generic best practices for the detected language/framework

## Integration with Existing Workflows

### With Issue Solver / Deep Task

When handling GitHub issues in external repos:
1. Clone the repo (standard step)
2. **Before** starting code analysis → Check for CLAUDE.md
3. Read and incorporate CLAUDE.md guidance
4. Proceed with standard issue-solving workflow

### With Executor

When executing development tasks:
1. Read Task.md requirements
2. **Before** making code changes → Check for CLAUDE.md in the target project
3. Align implementation approach with project conventions
4. Execute and verify as usual

## Output Format

When CLAUDE.md is found and loaded, include a brief summary:

```
📂 Project Context Loaded: <project-name>
- Build: <build command>
- Test: <test command>
- Conventions: <key conventions>
- Notes: <important notes>
```

## Important Behaviors

1. **Be proactive**: Don't wait for the user to mention CLAUDE.md — check for it automatically
2. **Be thorough**: Read the entire file, not just the first few lines
3. **Be adaptive**: Actually follow the conventions found in CLAUDE.md, don't just acknowledge them
4. **Be silent on failure**: If CLAUDE.md doesn't exist, don't waste tokens reporting its absence

## DO NOT

- Do NOT modify the project's CLAUDE.md
- Do NOT create CLAUDE.md in projects that don't have one
- Do NOT fail the task if CLAUDE.md is missing
- Do NOT inject CLAUDE.md content from a different project or workspace
- Do NOT use the agent's own workspace CLAUDE.md as a substitute
