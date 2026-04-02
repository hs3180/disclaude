# Skill: Load Project Context

## Context

- Project Directory: {projectDir} (defaults to current working directory if not specified)

## Role

Project context loader specialist. When an agent begins working on a development project, this skill loads and analyzes the project's `CLAUDE.md` file (if present) to understand the project's development requirements, conventions, and architecture.

## When to Use

Use this skill when:
- Starting work on a newly cloned or downloaded development project
- Beginning any development task (bug fix, feature implementation, refactoring) in an unfamiliar codebase
- A user explicitly requests `/load-project-context`
- Any scheduled task or workflow enters a project directory and needs to understand the project before making changes

## Responsibilities

1. Locate the project root directory
2. Check for `CLAUDE.md` in the project root
3. If found, read and analyze its content
4. Extract and summarize key project information
5. Output a structured context summary for the agent to use

## Workflow

### Step 1: Locate Project Root

Identify the project directory:
- If `projectDir` is specified in context, use it directly
- Otherwise, use the current working directory
- Look for `CLAUDE.md` at the root of the project directory

### Step 2: Check for CLAUDE.md

```bash
# Check if CLAUDE.md exists
ls -la {projectDir}/CLAUDE.md
```

### Step 3A: CLAUDE.md Found

Read the file and extract key information:

```bash
cat {projectDir}/CLAUDE.md
```

### Step 3B: CLAUDE.md Not Found

If `CLAUDE.md` does not exist, try these alternatives in order:

1. `CLAUDE.md` (root level) - primary
2. `.claude/CLAUDE.md` - alternative location
3. `.github/copilot-instructions.md` - GitHub Copilot instructions (similar purpose)
4. `README.md` - fallback for project overview

If none found, output a brief note and proceed without project context.

### Step 4: Analyze and Summarize

When `CLAUDE.md` (or equivalent) is found, analyze it and extract:

| Category | What to Extract |
|----------|-----------------|
| **Project Overview** | What the project does, its purpose and scope |
| **Architecture** | Module structure, key components, data flow |
| **Development Commands** | Build, test, lint, and other dev commands |
| **Coding Standards** | Code style, naming conventions, formatting rules |
| **Testing Requirements** | Test framework, coverage expectations, test patterns |
| **Commit/PR Conventions** | Commit message format, PR description requirements |
| **Special Guidelines** | Any project-specific rules, pitfalls, or important notes |
| **Common Pitfalls** | Known issues, things to avoid, tricky areas |

### Step 5: Output Context Summary

Output a structured summary in this format:

```markdown
## Project Context: {project_name}

> Loaded from: `CLAUDE.md` in `{projectDir}`

### Overview
(Brief project description)

### Architecture
(Key components and module structure)

### Development Commands
| Command | Purpose |
|---------|---------|
| `npm run build` | Build the project |
| `npm test` | Run tests |
| ... | ... |

### Coding Standards
- (Standard 1)
- (Standard 2)

### Testing Requirements
- (Requirement 1)
- (Requirement 2)

### Important Notes
- (Note 1)
- (Note 2)

### Common Pitfalls
- (Pitfall 1)
- (Pitfall 2)
```

If no `CLAUDE.md` or equivalent is found, output:

```markdown
## Project Context: {project_name}

> No `CLAUDE.md` found in `{projectDir}`. Proceeding with general best practices.
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `CLAUDE.md` not found | Try alternatives (`.claude/CLAUDE.md`, `.github/copilot-instructions.md`, `README.md`). If none found, output note and continue. |
| File is empty | Output note that file is empty and continue. |
| File is very large (>100KB) | Read and summarize the most relevant sections (Development Commands, Coding Standards, Testing). |
| Directory doesn't exist | Report error and ask for correct path. |

## Integration with Other Skills/Workflows

This skill is designed to be used at the **beginning** of a development workflow. After loading project context, the agent should:

1. Use the extracted coding standards when writing code
2. Follow the specified testing requirements
3. Use the correct development commands (build, test, lint)
4. Respect commit/PR conventions when submitting changes
5. Avoid documented common pitfalls

### Example: Issue Solver Integration

In the issue-solver workflow, after cloning the repository:

```
### Step 1.5: Load Project Context
Before analyzing the issue, load project context:
1. Check for CLAUDE.md in the cloned repository root
2. Read and summarize project conventions
3. Use this context when implementing the fix
```

### Example: Manual Usage

User: `/load-project-context /path/to/project`
Agent: Reads CLAUDE.md and outputs structured summary.

## Tools Available

- `Read`: Read CLAUDE.md and other project files
- `Bash`: Check file existence, run development commands
- `Glob`: Find alternative context files
- `Grep`: Search for specific patterns in CLAUDE.md

## Stopping Rules

**IMMEDIATE STOP AFTER OUTPUT**

1. After outputting the context summary, STOP
2. Do not begin implementing changes
3. Do not modify any files
4. Let the calling workflow (issue-solver, user request, etc.) decide what to do next

The sole purpose of this skill is to **load and present** project context. It does not execute any development tasks.
