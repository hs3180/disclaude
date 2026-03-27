---
name: project-context
description: Auto-load project CLAUDE.md for development context. Use when starting work on a development project, cloning a repo, or switching to a new project directory to understand project conventions, coding standards, and architecture. Keywords: 项目上下文, CLAUDE.md, 开发项目, project context, dev setup, 项目约定, 编码规范.
---

# Project Context Loader

You are a project context specialist. When the user asks you to work on a development project (fix a bug, implement a feature, refactor code, review code, etc.), you MUST load the project's own `CLAUDE.md` before starting any development work.

## Why This Matters

Every well-maintained project has its own conventions, coding standards, testing rules, and architectural decisions documented in `CLAUDE.md`. Working on a project without reading its `CLAUDE.md` is like driving in a foreign country without knowing the traffic rules — you'll get things done, but likely make mistakes that violate local conventions.

## When to Activate

**Activate this workflow when:**
- User asks you to work on a specific project/repository
- You are about to clone or download a development project
- You need to switch to a new project directory for development work
- User mentions a GitHub repo URL, local project path, or asks you to "fix/implement/review" something in a project

**DO NOT activate when:**
- User asks a general question not tied to a specific project
- You are already working in a project and have already loaded its context
- The task is purely conversational or informational

## Workflow

### Step 1: Locate or Obtain the Project

If the project is not already available locally:
- **Git repo**: Clone it using `git clone <url>`
- **Local path**: Navigate to it using `cd`
- **Download**: Download and extract if provided as an archive

### Step 2: Navigate to the Project Root

```bash
cd /path/to/project
```

Verify you are in the correct directory by checking for common project root indicators:
- `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.
- `.git/` directory
- `CLAUDE.md` or `.claude/` directory

### Step 3: Load Project Context

**Check for `CLAUDE.md` at the project root:**

```bash
# Check if CLAUDE.md exists
ls CLAUDE.md 2>/dev/null && echo "EXISTS" || echo "NOT_FOUND"
```

**If `CLAUDE.md` exists:**
1. Read the entire file using the Read tool
2. Identify key sections: commands, architecture, coding rules, testing requirements
3. Apply the project's conventions to ALL subsequent work

**If `CLAUDE.md` does NOT exist:**
1. Check for alternative context files:
   - `.claude/CLAUDE.md` (subdirectory)
   - `README.md` (project overview)
   - `CONTRIBUTING.md` (contribution guidelines)
   - `.editorconfig` (editor settings)
   - `eslint.config.*`, `.prettierrc.*` (linting rules)
2. If no context files exist, proceed with general best practices and note the absence
3. Do NOT create a CLAUDE.md for the project unless explicitly asked

### Step 4: Apply Project Context

After loading the project's CLAUDE.md, strictly follow its guidelines:

| Guideline Type | How to Apply |
|----------------|-------------|
| **Build commands** | Use the project's specified build/test/lint commands, not generic ones |
| **Architecture rules** | Follow the project's file structure and module organization |
| **Coding standards** | Match the project's naming conventions, style, and patterns |
| **Testing requirements** | Write tests according to the project's testing framework and rules |
| **Git conventions** | Follow the project's commit message format and branch naming |
| **Forbidden practices** | Respect any "DO NOT" or prohibited patterns in CLAUDE.md |

### Step 5: Confirm Context Loaded

Before starting actual development work, briefly acknowledge the loaded context:

> "I've loaded the project's CLAUDE.md. I'll follow [project name]'s conventions: [summarize 2-3 key rules]."

Keep this confirmation concise — do NOT dump the entire CLAUDE.md content back to the user.

## Important Behaviors

1. **Always load FIRST**: Read CLAUDE.md BEFORE writing any code, making any changes, or running any commands
2. **Respect project rules**: If CLAUDE.md says "use X, not Y", always use X even if you prefer Y
3. **Check for updates**: If you've been working on a project for a while, re-check CLAUDE.md if you suspect it may have changed
4. **Project-specific overrides general**: When project CLAUDE.md conflicts with your general knowledge, follow the project

## DO NOT

- **DO NOT** skip loading CLAUDE.md because you "already know" the project
- **DO NOT** modify the project's CLAUDE.md unless explicitly asked
- **DO NOT** create a CLAUDE.md for projects that don't have one
- **DO NOT** apply a different project's conventions to the current project
- **DO NOT** ignore the project's testing rules — if CLAUDE.md says "tests must use nock, not vi.mock", follow that rule
- **DO NOT** start coding before reading the project context

## Graceful Degradation

| Scenario | Action |
|----------|--------|
| `CLAUDE.md` exists at root | Read and follow it |
| `CLAUDE.md` in `.claude/` subdirectory | Read and follow it |
| No `CLAUDE.md`, but `README.md` exists | Read README.md for basic project info |
| No `CLAUDE.md`, but config files exist | Infer conventions from config files |
| No context files at all | Proceed with general best practices, note the absence |
| `CLAUDE.md` is empty or minimal | Follow what's there, use general best practices for the rest |
