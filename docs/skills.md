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

## Optional diagnostics plugin

`diagnose-logs` is optional first-party operational guidance for **Disclaude
service issues**. A clean install does not include it in the builtin skill
manifest or prompt index. It is not a generic log-analysis skill, and the
service has no dependency on an installed diagnostics plugin.

Run these commands from the project directory, or select the bound Project
explicitly (the directory must already exist):

```sh
disclaude plugins list --project-dir /path/to/project
disclaude plugins install diagnostics --project-dir /path/to/project
disclaude plugins update diagnostics --project-dir /path/to/project
disclaude plugins remove diagnostics --project-dir /path/to/project
```

The CLI copies the official version shipped under `optional-plugins/diagnostics/`
into `<project>/.disclaude/plugins/diagnostics/`. This is an offline install,
separate from the default `skills/` bundle; it downloads no code or dependencies.
Only this official plugin is supported. Installation is project-scoped and
does not change other Projects, home-directory skills or the service configuration.
Omitting `--project-dir` selects the current directory, not the configured
service workspace. The CLI does not start or restart services.

After installing, start a new agent session in that Project. Claude loads the
installed directory through its local-plugin API; Codex exec/app-server indexes
it through `SkillsRegistry`; DSH receives the same compact skill manifest and
can read the linked instructions using its profile's file/shell tools. A custom
DSH profile must provide a tool capable of reading local Markdown. References
resolve from the actual execution directory, including Project subdirectories.
Codex treats installed plugin skills at user precedence, so explicit project
skills override them.

To update, upgrade Disclaude first and run `plugins update diagnostics`; an
existing install is not silently replaced by a Disclaude upgrade. Repeating
install/update with identical content and removing an absent plugin are safe.
Update and removal verify the CLI's installation receipt and refuse edited,
extra, incomplete or symlinked content. Preserve such content and move the
plugin directory aside manually before reinstalling. Commands return one JSON
result with `ok: true`, or `ok: false` and a nonzero exit status. `plugins list`
reports availability and installed presence without creating files.

Removal deletes only the unchanged CLI-owned plugin directory. Start a new
agent session after removal; an already-running session may retain previously
loaded instructions in its context. User data and other skills are retained.

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

See [`skills/browser-use/SKILL.md`](../skills/browser-use/SKILL.md) for browser
automation. The packaged channel CLI is documented by its registry `SKILL.md`
plus `disclaude channel help`. The [Jupyter CLI Skill](../skills/jupyter/README.md)
adds optional remote Notebook research through `disclaude jupyter`, using the
agent's existing shell tool without extending ChatAgent's session lifecycle.
