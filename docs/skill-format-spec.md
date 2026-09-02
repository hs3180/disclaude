# disclaude Skill Format Spec (CLI + README)

> **Status:** Draft — part 2 of [#4459](https://github.com/hs3180/disclaude/issues/4459) (Retire
> disclaude MCP server support → migrate to Skills). Implements **Scope 2 (Skill 格式定义)**.
> The owner decision is recorded in [#4383](https://github.com/hs3180/disclaude/issues/4383)
> (2026-08-07): **reduce MCP**; the pi backend ships **no MCP** (see
> [docs/pi-mcp-landing-research.md](./pi-mcp-landing-research.md) §B-Q1 — zero MCP client/server
> symbols at `@earendil-works/pi-agent-core@0.82.1–0.83.0`), so disclaude unifies both backends on
> the **Skills (CLI + README)** model. This spec formalizes that contract so the migrations in
> scopes 3–4 (and the sibling Playwright migration [#4460](https://github.com/hs3180/disclaude/issues/4460))
> don't reinvent it per-tool.
>
> **Non-goal:** deciding which MCP surface migrates to which target. That is scope 3 (per-tool) and
> is only sketched as context in [§5](#5-relationship-to-the-mcp-surfaces-context). The full surface
> map lives in [docs/mcp-server-inventory.md](./mcp-server-inventory.md) (part 1, PR #4462, in flight).

---

## 1. What a disclaude Skill is (and isn't)

Two distinct "skill" concepts coexist in disclaude. This spec defines **one** of them — the
**CLI Skill** — which is the MCP-replacement target.

| | Agent-skill (existing, unchanged) | **CLI Skill (this spec — pi-aligned)** |
|---|---|---|
| Form | `skills/<name>/SKILL.md` (YAML frontmatter + prompt body) | `skills/<name>/cli.mjs` **+** `README.md` |
| Invoked by | SDK dispatch — the agent loads `SKILL.md`, acts via `allowed-tools` | a **process** the agent shells out to: `node skills/<name>/cli.mjs <command> …` |
| Tool surface | whatever `allowed-tools` grants (incl. MCP tools today) | its own `cli.mjs` subcommands |
| Replaces | nothing — disclaude's native skill-dispatch mechanism | an **MCP server** (stdio *or* inline) |
| Examples | `skills/skill-creator/SKILL.md`, `skills/issue-solver/SKILL.md` | `skills/channel/` (reference implementation) |

A **CLI Skill** is a deterministic command-line program. The agent runs it through the shell
(`Bash`), reads its output, and acts on it — instead of the runtime calling an MCP tool in-process.
Output is **structured** (one JSON object on stdout) so the agent can parse it reliably; binary or
large results go to **disk artifacts** ([§4](#4-artifact-contract)) rather than stdout.

**Why CLI, not in-process:** MCP couples the agent runtime to a tool protocol the pi backend cannot
speak (pi has no MCP — see above). A CLI is a universal, runtime-agnostic interface: both the
claude backend (today) and the pi backend (no MCP) shell out to the same `cli.mjs`. The agent-facing
behavior is identical to an MCP tool (call → structured result), but the transport is a process, not
an in-process RPC.

> A CLI Skill is **not** the same as the existing `SKILL.md` agent-skill. The two coexist: a
> `SKILL.md` may *use* a CLI Skill (shell out to `cli.mjs`) as one of its tools. Nothing in this spec
> changes how `SKILL.md` skills are authored or dispatched.

---

## 2. CLI invocation contract

This is the core contract a `cli.mjs` must honor. It generalizes the concrete pattern already
implemented by the channel reference skill (`skills/channel/cli.mjs`) so every migrating tool looks
the same to the agent.

### 2.1 Command line

```
node skills/<name>/cli.mjs <command> [positional args] [--options]
```

- **`<command>`** — a positional subcommand (e.g. `screenshot`, `script`, `snapshot`, `list`). Each
  Skill publishes its own command set in its README ([§3](#3-readme-schema)).
- **Positional args** — command-specific, in a fixed order.
- **Options** — `--flag` (boolean) and `--opt VALUE` (value). Long-form only (no single-letter
  aliases) to keep READMEs unambiguous and LLM-friendly.
- **Large / structured input** — accept a JSON payload via `--<opt> '<JSON>'`, or `--<opt> @FILE`
  (read from a path), or piped on **stdin**. Never require the agent to embed multi-KB JSON inline.

### 2.2 stdout — exactly one JSON object

**The single hardest rule:** stdout contains *exactly one* JSON object and nothing else. All
diagnostics, progress, and logs go to **stderr** (the agent does not parse stderr as a result).

```jsonc
// success — process exits 0
{"ok":true,"command":"screenshot","url":"https://example.com","artifact":"shot.png","durationMs":820}

// failure — process exits 1
{"ok":false,"command":"screenshot","error":"navigation timeout after 30000ms","hint":"pass --wait <ms|selector> to extend the wait"}
```

Common, reserved fields:

| field | always? | meaning |
|---|---|---|
| `ok` | **yes** | `true` on success, `false` on any failure |
| `command` | **yes** | echo of the subcommand that ran (disambiguates `script` step results) |
| `error` | on `ok:false` | short, human-readable failure message |
| `hint` | optional, `ok:false` | actionable remediation (a flag to add, a dep to install, a retry) |
| `durationMs` | recommended | wall-clock of the operation, for parity/observability vs the MCP tool it replaces |
| `artifact` / `artifacts` | when produced | path(s) to disk artifacts ([§4](#4-artifact-contract)) |

Command-specific success fields are at the Skill's discretion but **must** be documented in the README.

> **Plain-text Skills:** a Skill whose result is inherently short free-text (e.g. a one-line lookup)
> *may* print plain text instead of JSON. If it does, it must say so in its README and still honor
> the exit-code / stderr conventions. JSON is the default and the recommended shape — it composes
> (extra fields can be added without breaking the agent) where free-text does not.

### 2.3 Exit codes

| code | meaning |
|---|---|
| `0` | success — `{"ok":true,…}` on stdout |
| `1` | any failure (bad args, validation, runtime error) — `{"ok":false,"error":…}` on stdout |
| `≥2` | **reserved — do not use.** Shells, process-spawn shims, and Node's own conventions overload these; agents should be able to treat `nonzero == failure` uniformly. |

A failure must emit the JSON error object on stdout *and* exit non-zero. The agent can rely on
either signal; both must agree.

### 2.4 Errors: throw / exit, don't encode success

Mirror the pi tool contract (see
[`packages/core/src/sdk/providers/pi/inline-tool-adapter.ts`](../packages/core/src/sdk/providers/pi/inline-tool-adapter.ts),
issue #4387): **failures are reported as failures** (`ok:false` + nonzero exit), never as a
`{"ok":true, result: "error: ..."}`. Encoding errors inside a success payload hides them from the
agent's error handling. On an unexpected throw the CLI should catch it and emit a best-effort
`{"ok":false,"command":…,"error":…}` before exiting 1, so a crash still yields a parseable result.

---

## 3. README schema

Every CLI Skill ships a `README.md` next to its `cli.mjs`. The README is the Skill's contract with
the agent (and with humans) — the agent reads it to learn the command surface, just as it would read
an MCP tool's schema. Required sections:

1. **Header + status** — one-line purpose; a `Status` note stating parity with the MCP tool it
   replaces and what (if anything) is deferred (see the channel README for the pattern: *"command
   surfaces + output contracts implemented; live parity deferred"*, with per-part PR links).
2. **Quick start** — copy-pasteable `node skills/<name>/cli.mjs …` invocations that work end-to-end,
   plus a one-time runtime-install line if the Skill needs host deps.
3. **Commands** — a table of every subcommand: name, positional args, options (`--flag`/`--opt`).
4. **Output contract** — a copy/re-statement of the stdout shape for this Skill's commands (the
   success and failure JSON, with the command-specific fields filled in).
5. **Artifacts** ([§4](#4-artifact-contract)) — what files the Skill writes, where, and their
   lifecycle.
6. **Runtime** — host dependencies the Skill needs (browser binaries, OS libs, API keys) and how to
   install them. State honestly what is *not* bundled.
7. **Parity / migration notes** — the deltas vs the MCP tool being replaced, recorded explicitly
   (required by #4459 / #4460 acceptance: *"迁移/下线不静默"*).

The README may cross-link to a sibling `SKILL.md` if the Skill also has an agent-dispatch wrapper
(the browser-use case: `SKILL.md` is the agent-facing skill text, the piped-Python `browser-use` CLI
is what it drives).

---

## 4. Artifact contract

Binary or bulky results (screenshots, accessibility-snapshot JSON, session/storage state, downloaded
files) are **never** base64-stuffed into the JSON result. They are written to disk and referenced by
path.

- **Default location** — a per-Skill working dir under the workspace, e.g. `workspace/<skill>/` or
  `./lark-im-resources/` (the convention already used by the `lark-cli im` resource downloads). The
  README declares the exact path.
- **Result references** — stdout JSON carries an `artifact` (single path) or `artifacts` (array)
  field; the agent then `Read`s the path.
- **Session / state continuity** — long-lived state (cookies, `storageState`, a browser profile) is
  persisted to a named file and threaded between invocations via an option such as
  `--session <file>`. This is the CLI-Skill equivalent of an MCP "live session": a *single* run owns
  one session; cross-call continuity is by passing the session file back in. (No in-repo Skill needs
  this yet — the browser-use CLI keeps its daemon session internally — so the option is a
  convention to adopt when a Skill first needs it, not an existing example.)
- **Lifecycle** — the README states whether artifacts are overwritten, accumulated, or
  caller-managed. Skills should default to **non-destructive** (don't delete files the agent may
  still want) unless documented otherwise.

---

## 5. Relationship to the MCP surfaces (context)

The MCP inventory (part 1, [docs/mcp-server-inventory.md](./mcp-server-inventory.md), PR #4462)
maps **three** MCP surfaces. This spec is the *format* every replacement must follow; **which**
surface maps to which target is a per-tool decision (scope 3), sketched here only for orientation:

| Surface | Transport | Lives in | Migration target (scope 3 decides) |
|---|---|---|---|
| **S1** `channel-mcp` — disclaude's own messaging tools (`send_text`/`send_card`/`send_interactive`/`send_file`/`push_to_agent`; the loop tools were removed with the loop system, #4430) | inline / in-process | `packages/channel-cli/src/` | **Migrated and removed (#4652/#4726).** All five operations surface through [`skills/channel/cli.mjs`](../skills/channel/README.md); no in-process MCP package remains. |
| **S2** External stdio MCP servers (Playwright + user-configured) | stdio subprocess | ~~config `tools.mcpServers`; loader `mcp-setup.ts`~~ (**removed**, `#4459` Scope 4) | **CLI Skills / Skills.** Primary target — Playwright consumers are retired in favor of the [`browser-use` skill](../skills/browser-use/SKILL.md) ([#4460](https://github.com/hs3180/disclaude/issues/4460)); user stdio servers wrap as Skills per this spec. |
| **S3** disclaude standalone stdio MCP server | stdio | — | **Removed (#4726).** External consumers should use the Channel CLI Skill or another supported integration. |

**What this spec fixes** (so scope 3 doesn't have to): for any surface that migrates to a CLI Skill
(S2 certainly; S1/S3 possibly), the `cli.mjs` + `README.md` it produces conforms to
[§2](#2-cli-invocation-contract)–[§4](#4-artifact-contract). The inline-tool adapter (#4387) is the
*other* retained tool path (in-process, not a CLI) and is explicitly **out of scope** for retirement
([#4459](https://github.com/hs3180/disclaude/issues/4459): *"保留 inline-tool adapter #4387"*).

---

## 6. Reference implementation

`skills/channel/` is the canonical CLI Skill:

- `cli.mjs` — subcommands (`send_text` / `send_interactive` / `send_file`), long inputs accepted as
  `--<opt> '<JSON>'` / `--<opt> @FILE` / stdin, so multi-KB payloads never go inline.
- emits exactly one JSON object: `{"ok":true,"command":…,"result":…,"durationMs":…}` /
  `{"ok":false,"command":…,"error":…,"hint":…}`.
- reuses the first-party implementations from `packages/channel-cli` over REST — same impl as the
  MCP tool it replaces, different transport (see its Parity / migration notes table).
- `README.md` — Quick start, Commands table, Output contract, Artifacts, Runtime, Parity /
  migration notes, Status (per-part PR links; live parity deferred where noted).

For browser automation the corresponding surface is the **`browser-use` skill**
([`skills/browser-use/SKILL.md`](../skills/browser-use/SKILL.md)) — an agent-skill whose tool is an
*external* piped-Python CLI rather than an in-repo `cli.mjs`. It follows the same output philosophy
(stdout is the result channel, one JSON blob per invocation, binary artifacts on disk) and is the
S2/Playwright replacement; it just isn't the in-repo `cli.mjs` reference.

New Skills should copy the `channel` structure and diverge only where their domain demands it.

---

## 7. Conformance checklist (for a migrating tool)

Before a tool's MCP form is retired ([#4459](https://github.com/hs3180/disclaude/issues/4459) scope
3–4), its CLI Skill must:

- [ ] `cli.mjs` + `README.md` exist under `skills/<name>/`.
- [ ] stdout is exactly one JSON object (or documented plain-text); all logs on stderr.
- [ ] exit `0`/`1` only; `ok` agrees with the exit code; errors are failures, not encoded successes.
- [ ] binary/large results are disk artifacts referenced by path, not inlined.
- [ ] README has all seven sections from [§3](#3-readme-schema), incl. explicit **parity deltas**.
- [ ] the MCP tool it replaces is removed in the same cutover (or the removal is tracked) — no silent
      dual existence.
