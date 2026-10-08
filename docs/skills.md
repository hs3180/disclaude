# Skills

Disclaude supports agent-invoked `SKILL.md` instructions and CLI tools
documented by a Skill `README.md`. An agent Skill teaches a harness when and how
to act; a CLI Skill documents a deterministic command the agent can invoke.

## Discovery and precedence

`SkillsRegistry` lives in `@disclaude/core` and is shared across harnesses.
Callers provide builtin, user, and project roots; the registry does not infer a
project from the process working directory or read harness-specific home
directories. Each root contains `skills/<name>/SKILL.md`.

Project skills override user skills, which override builtins. A same-priority
name collision fails. Resolution returns the effective skills, a stable
revision, a compact manifest, and separate diagnostics. Only the manifest
belongs in model-facing prompts. Resource references are relative to their
source root; adapters retain that mapping when loading them.

The shared project layout is `.disclaude/skills/<name>/SKILL.md`. Codex exec
and app-server also accept the existing top-level `skills/<name>/SKILL.md`;
both are project-precedence sources, so duplicate names are rejected.
`.claude/skills` remains Claude-specific and is not scanned by the shared
registry. Put cross-harness skills in `.disclaude/skills` and keep
Claude-only skills in `.claude/skills`.

## CLI Skill contract

A CLI Skill exposes a documented command, either as a packaged executable
(such as `disclaude channel`) or as a script:

```sh
node skills/<name>/cli.mjs <command> [arguments] [options]
```

Use stable subcommands and long option names. Document arguments, accepted
values, and side effects. Accept large structured input from a file or stdin;
send diagnostics to stderr. By default, stdout should contain one
machine-readable JSON result and the process should exit nonzero on failure.
JSON results use `ok: true` or `ok: false` rather than encoding an error as
success.

The Skill `README.md` is its human- and agent-facing interface. Document a
working quick start, commands and side effects, output and errors, runtime
requirements, persistent state and ownership, artifacts, and limitations. Link
to a sibling `SKILL.md` when the CLI also has agent-facing instructions.

Keep binary or bulky artifacts outside JSON and return their paths. Explain
whether files are overwritten, accumulated, or caller-managed. Preserve user
data by default and document any deletion or replacement. Do not imply that
state is shared across invocations unless that behavior is implemented.

See [`skills/channel/README.md`](../skills/channel/README.md) for the packaged
channel CLI and [`skills/browser-use/SKILL.md`](../skills/browser-use/SKILL.md)
for browser automation. The [Jupyter CLI Skill](../skills/jupyter/README.md)
adds optional remote Notebook research through `disclaude jupyter`, using the
agent's existing shell tool without extending ChatAgent's session lifecycle.
