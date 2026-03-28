---
name: project-context
description: Project CLAUDE.md auto-loader for development tasks. Detects and loads project-level CLAUDE.md to understand project requirements, coding conventions, and architecture before starting development work. Use when handling development tasks in a project directory, after cloning/downloading a repo, or when the user says keywords like "载入项目", "项目上下文", "CLAUDE.md", "project context", "开发任务", "修 bug", "实现功能".
allowed-tools: [Read, Bash, Glob, Grep, Task]
---

# Project Context Loader

You are a project context loading specialist. Your job is to detect and load project-level `CLAUDE.md` files to give the agent project-specific context before it starts development work.

## When to Use This Skill

**Trigger this skill when:**
- Agent has just cloned or downloaded a development project
- Agent is about to start development work (bug fix, feature, refactoring) in a project directory
- User explicitly requests loading project context or CLAUDE.md
- User mentions: "载入项目", "项目上下文", "CLAUDE.md", "开发任务"

**Do NOT trigger for:**
- Non-development tasks (chat, Q&A, general discussion)
- Tasks that don't involve a specific project directory
- Tasks in the workspace root (not a project)

## Core Concept

When working on a development project, `CLAUDE.md` in the project root contains critical information:
- Project structure and architecture
- Coding conventions and style rules
- Development workflow (build, test, lint commands)
- Important constraints and gotchas
- Commit message conventions

Loading this context BEFORE starting work dramatically improves the quality of code changes.

## Workflow

### Step 1: Identify Project Directory

Determine the project directory from context:

| Scenario | How to Detect |
|----------|--------------|
| After `git clone` | The cloned repo directory |
| After downloading/extracting | The extracted project directory |
| User-specified | From user message or context |
| Current working directory | Use `pwd` to verify |

**Detection method:**
```bash
# Check for project indicators in the current directory
ls -la | grep -E '(package\.json|Cargo\.toml|go\.mod|pyproject\.toml|pom\.xml|CLAUDE\.md|\.git)'
```

### Step 2: Check for CLAUDE.md

```bash
# Check if CLAUDE.md exists in the project root
test -f {projectDir}/CLAUDE.md && echo "FOUND" || echo "NOT_FOUND"
```

### Step 3: Load CLAUDE.md (If Found)

If `CLAUDE.md` exists, use the **Task tool** to spawn a sub-agent in the project directory:

**IMPORTANT**: The Task tool with `cwd` set to the project directory will cause the sub-agent to automatically load `CLAUDE.md` via the SDK's `settingSources: ['project']` mechanism. You do NOT need to manually read the file.

**Task tool usage:**
- **subagent_type**: `general-purpose`
- **isolation**: `worktree` (preferred) OR provide explicit `cwd` guidance
- **prompt**: Instruct the sub-agent to read and summarize the project's CLAUDE.md and provide key development guidelines

**Example prompt for Task tool:**
```
Read and analyze the CLAUDE.md file in the current project directory. Provide a concise summary covering:
1. Project structure and architecture
2. Coding conventions and style rules
3. Build, test, and lint commands
4. Important constraints or gotchas
5. Commit message conventions

Format the output as a structured summary that another agent can use as context.
```

### Step 4: Integrate Context

After the sub-agent returns the summary, integrate it into your current task:

1. **Adjust your approach**: Follow the project's coding conventions
2. **Use correct commands**: Use the project's build/test/lint commands
3. **Respect constraints**: Follow any constraints mentioned in CLAUDE.md
4. **Match commit style**: Follow the project's commit message conventions

### Step 5: Graceful Degradation (If Not Found)

If `CLAUDE.md` does NOT exist in the project:

1. **Check for alternatives** in priority order:
   - `CLAUDE.md`
   - `.claude/CLAUDE.md`
   - `README.md` (project overview section)
   - `CONTRIBUTING.md` (contribution guidelines)
   - `.editorconfig` (basic formatting rules)
   - `package.json` scripts section (for npm projects)

2. **Report findings**:
   ```
   No CLAUDE.md found in {projectDir}. Checked alternative sources:
   - README.md: {found/not found}
   - CONTRIBUTING.md: {found/not found}

   Proceeding with general best practices.
   ```

3. **Proceed normally**: Don't block on missing CLAUDE.md. Use general best practices.

## Output Format

After loading project context, provide a structured summary:

```markdown
## Project Context Loaded

**Project**: {project name from CLAUDE.md or directory name}
**CLAUDE.md**: {found/not found}

### Key Guidelines
- {guideline 1}
- {guideline 2}

### Build Commands
- Build: `{command}`
- Test: `{command}`
- Lint: `{command}`

### Coding Conventions
- {convention 1}
- {convention 2}
```

## Important Behaviors

1. **Always check before coding**: Load context BEFORE making any code changes
2. **Respect project rules**: Follow CLAUDE.md guidelines even if they differ from your defaults
3. **Be concise**: Summarize CLAUDE.md content, don't dump the entire file
4. **Non-blocking**: Missing CLAUDE.md should not block development work
5. **One-time load**: Load context once per project, not on every message

## Design Decisions (Issue #1506)

This skill implements the revised approach from Issue #1506:

| Aspect | Old Approach (PR #1513, rejected) | New Approach (this skill) |
|--------|------------------------------------|---------------------------|
| CLAUDE.md source | Workspace root directory | **Development project's own directory** |
| Load timing | Agent startup | **After finding/downloading project** |
| Load method | Inject into existing agent prompt | **Spawn sub-agent via Task tool** |
| Architecture | Modify MessageBuilder | **Prompt-based skill** |

### Why Task Tool for Sub-Agent?

1. **Automatic CLAUDE.md loading**: SDK's `settingSources: ['project']` automatically loads CLAUDE.md from the `cwd`
2. **Isolation**: Sub-agent runs in the project directory with its own context
3. **No core changes**: Pure skill-based, no modifications to core modules
4. **Consistent**: Follows the project's pattern of prompt-driven agent behavior

## DO NOT

- Manually read and inject CLAUDE.md into prompts (use Task tool instead)
- Block development work if CLAUDE.md is missing
- Load context from the workspace root (must be from the project directory)
- Re-load context on every message (load once per project)
- Ignore CLAUDE.md guidelines once loaded (follow them throughout the task)
