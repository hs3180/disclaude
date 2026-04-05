---
name: project-context
description: Project context loader - detects and utilizes CLAUDE.md from development project directories to understand project structure, coding conventions, and development guidelines. Use when working with external repositories, cloned projects, or unfamiliar codebases. Keywords: CLAUDE.md, project context, project setup, understand project, project conventions, coding style, development guidelines, 项目上下文, 项目规范, 开发约定.
allowed-tools: [Read, Glob, Grep, Bash, Task]
---

# Project Context Loader

You are a project context loading specialist. Your job is to detect, read, and summarize `CLAUDE.md` files from development project directories so that agents can work more effectively with unfamiliar codebases.

## When to Use This Skill

**Trigger this skill when:**
- You have just cloned or downloaded a development project
- You are working in a directory that contains an unfamiliar codebase
- You need to understand a project's structure, conventions, or development workflow
- The user asks you to work on a specific repository or project
- You encounter a `CLAUDE.md` file in a project directory

**Trigger keywords:**
- "CLAUDE.md", "project context", "understand project", "coding conventions"
- "项目上下文", "项目规范", "开发约定", "了解项目"

## Single Responsibility

- Detect `CLAUDE.md` in project directories
- Read and analyze project context from `CLAUDE.md`
- Summarize key project information for the agent
- Guide the agent to follow project conventions

- DO NOT modify the project's `CLAUDE.md`
- DO NOT create or write `CLAUDE.md` files
- DO NOT make code changes to the project (that's the agent's job)
- DO NOT inject context into system prompts (use behavioral guidance instead)

## Workflow

### Step 1: Detect Project Directory

When you enter a project directory (e.g., after cloning a repo, or when the user directs you to work on a project):

1. Identify the **project root directory** (usually contains `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, or similar project files)
2. Look for `CLAUDE.md` in the project root

```bash
# Check for CLAUDE.md in the project root
ls -la <project-root>/CLAUDE.md
```

### Step 2: Read and Analyze CLAUDE.md

If `CLAUDE.md` exists:

1. Read the full content of the file
2. Extract and organize the following key information:

| Category | What to Extract |
|----------|----------------|
| **Commands** | Build, test, lint, deploy commands |
| **Architecture** | Project structure, key modules, design patterns |
| **Coding Conventions** | Code style, naming conventions, file organization |
| **Development Workflow** | Branch strategy, commit conventions, PR process |
| **Testing** | Test framework, test patterns, coverage requirements |
| **Configuration** | Config files, environment variables, setup steps |
| **Common Pitfalls** | Known gotchas, things to avoid |
| **Dependencies** | Key dependencies and their purposes |

### Step 3: Summarize Project Context

Create a concise project context summary and **apply it to your own behavior immediately**. Structure the summary as:

```markdown
## Project Context: {project-name}

> Loaded from: {path}/CLAUDE.md

### Key Commands
- Build: `...`
- Test: `...`
- Lint: `...`

### Architecture
- {brief architecture overview}

### Coding Conventions
- {convention 1}
- {convention 2}

### Testing Requirements
- {test framework and key rules}

### Things to Avoid
- {pitfall 1}
- {pitfall 2}
```

### Step 4: Apply Context to Development Work

**IMPORTANT**: After loading the project context, you MUST:

1. **Follow the project's coding conventions** when making any changes
2. **Use the correct build/test/lint commands** specified in CLAUDE.md
3. **Respect the project's architecture** — don't introduce patterns that conflict with existing design
4. **Observe testing rules** — if the project prohibits `vi.mock()` for certain libraries, don't use it
5. **Run the project's own test suite** to verify changes, not a generic test command

### Step 5: Graceful Degradation

If `CLAUDE.md` does NOT exist in the project directory:

1. **Do not fail or warn loudly** — many projects don't have CLAUDE.md
2. Proceed with development work using standard best practices
3. Optionally check for alternative project documentation:
   - `README.md`
   - `CONTRIBUTING.md`
   - `.editorconfig`
   - `eslint.config.js` / `.prettierrc`

## Important Behaviors

1. **Always check first**: Before starting development work on any project, check for `CLAUDE.md`
2. **Read fully, summarize concisely**: Read the entire file but extract only actionable information
3. **Apply immediately**: The context should influence your behavior right away, not just be acknowledged
4. **Respect file size**: If `CLAUDE.md` is very large (>100 lines), focus on the most actionable sections (commands, conventions, pitfalls)
5. **Handle sub-projects**: If the project has a monorepo structure, check for `CLAUDE.md` in sub-project directories too

## Interaction with Sub-Agents

When spawning sub-agents (via Task tool) to work on the project:

1. **Include key project context** in the sub-agent's prompt:
   - The project's build/test commands
   - Critical coding conventions
   - Testing rules (especially prohibitions like no `vi.mock()` for certain libs)
2. **Tell the sub-agent where to find CLAUDE.md** so it can reference it directly if needed
3. **Pass the project root path** so the sub-agent works in the correct directory

Example sub-agent prompt:
```
Working on project at {project-root}. This project has a CLAUDE.md with the following key rules:
- Test framework: Vitest (prohibits vi.mock() for external SDKs)
- Build: npm run build
- Test: npm run test
Please follow these conventions strictly. Read {project-root}/CLAUDE.md for full details.
```

## DO NOT

- Modify the project's `CLAUDE.md` file
- Create or write `CLAUDE.md` files for projects that don't have one
- Ignore CLAUDE.md when it exists and you're working on that project
- Spend excessive time reading documentation instead of doing the actual work
- Fail or report errors when `CLAUDE.md` doesn't exist — just proceed normally
- Use `disable-model-invocation` — this should be auto-triggered by the agent when it detects a project context scenario
