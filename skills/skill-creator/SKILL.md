---
name: skill-creator
description: Create or adapt an external skill for a named CLI, API or workflow when the user asks to build a reusable skill or integration.
allowed-tools: [Read, Write, Bash]
---

# Build an external skill

Use the user's stated purpose and chosen tool. Ask only for missing details that affect implementation. Keep provider authentication and business workflow code in the external skill, outside disclaude core and its bundled skills.

## Quick start

Run this skill's sibling `scripts/create-skill.mjs` with a name, destination parent, description and external executable. Resolve the script relative to this SKILL.md, not the shell's current directory.

From a disclaude source checkout, for example:

```sh
node skills/skill-creator/scripts/create-skill.mjs team-tool /path/to/external-project/skills 'Query team resources using the team CLI' team-cli
```

The installed distribution includes the same script under its `skills/skill-creator/scripts/` directory. It creates a complete `team-tool/SKILL.md`, prints its destination as JSON, and refuses to overwrite an existing skill. No API request or authentication exchange runs during creation.

Open the generated file and add the actual task workflow: required arguments, useful read operations, mutation preconditions and how the external tool reports failure. The generated `--help` invocation is a starting point; it does not install or authenticate the external executable.

## Provider integration recipe

1. Choose an externally installed CLI or put a small API wrapper in the new skill's own `scripts/` directory. Add dependencies to that external project, not disclaude.
2. Keep provider login, token formats, permission scopes, refresh and API semantics in that skill. A missing dependency or authorization should produce an actionable failure, not an implicit host credential refresh.
3. When the user must supply a private value, connect an explicitly configured private-input consumer. The consumer receives the value through stdin, with its bound initiator metadata separately; it chooses how to exchange or use it. Do not put the value in a chat command, prompt, normal tool result or globally inherited environment.
4. Verify with a synthetic input first. Check the actual successful result, a missing-authorization case and a failed operation. Only run a live mutation when it is within the user's authorized task.

The generic task-grant proposal in #4973 is separate work. Do not claim that the starter provides task-scoped grants, provider revocation or child-agent isolation. Shared `.runtime-env` maintenance belongs to the agent and affects other sessions/agents using that workspace.

## Install and use

Keep the external project separately versioned. For a project-local agent skill, place or copy the chosen directory under `<workspace>/.claude/skills/<name>/`. Claude reads project skills through its project settings; disclaude's Codex adapter also discovers that layout for the current query workspace. Other harnesses must use their documented discovery path; do not promise automatic discovery for every harness.

Start a fresh agent turn/session and verify that the intended skill is discovered. If discovery is unavailable, the agent can explicitly read the external SKILL.md and use its CLI. A service restart is not an installation step and should not be performed just to create a skill.

Removing a bundled skill does not delete copies or scheduled jobs already created in a user's workspace. Move those copies to the chosen external project and update scheduled script paths explicitly. Missing external tooling or authorization must be reported; do not silently recreate bundled authentication code.

## Minimal skill format

A skill directory needs `SKILL.md` with YAML `name` and `description`, followed by focused Markdown instructions. Add scripts or references only when the workflow uses them. Store no live credentials in these files. Use a specific description so ordinary requests do not accidentally trigger skill creation.
