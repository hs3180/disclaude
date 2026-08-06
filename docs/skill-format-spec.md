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
| Examples | `skills/skill-creator/SKILL.md`, `skills/issue-solver/SKILL.md` | `skills/playwright-agent/` (CLI form: PR #4464, reference implementation) |

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
implemented by the Playwright reference skill (PR #4464) so every migrating tool looks the same to
the agent.

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
   replaces and what (if anything) is deferred (see #4464's README for the pattern: *"CLI command
   surface + artifact contract implemented; live parity deferred to part 2"*).
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
(the Playwright case: `SKILL.md` is the background agent, `cli.mjs`+`README.md` is the CLI Skill).

---

## 4. Artifact contract

Binary or bulky results (screenshots, accessibility-snapshot JSON, session/storage state, downloaded
files) are **never** base64-stuffed into the JSON result. They are written to disk and referenced by
path.

- **Default location** — a per-Skill working dir under the workspace, e.g. `workspace/<skill>/` or
  `./lark-im-resources/` (the convention already used by the `lark-cli im` resource downloads). The
  README declares the exact path.
- **Result references** — stdout JSON carries an `artifact` (single path) or `artifacts` (array)
  field; the agent then `Read`s the path. The Playwright skill uses `artifact:"shot.png"`
  (PR #4464).
- **Session / state continuity** — long-lived state (cookies, `storageState`, a browser profile) is
  persisted to a named file and threaded between invocations via an option such as
  `--session <file>` (PR #4464). This is the CLI-Skill equivalent of an MCP "live session": a
  *single* `script --steps` run owns one session; cross-call continuity is by passing the session
  file back in.
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
| **S1** `channel-mcp` — disclaude's own messaging tools (`send_text`/`send_card`/`send_interactive`/`send_file`/`push_to_agent` + loop tools) | inline / in-process | [`packages/mcp-server/src/channel-mcp.ts`](../packages/mcp-server/src/channel-mcp.ts) | **Open.** These are in-process functions, not stdio servers — per [pi-mcp-landing-research.md](./pi-mcp-landing-research.md) §B-Q4 they are "just in-process functions" already covered by the **inline-tool adapter** (#4387). Whether they additionally surface as CLI Skills is a scope-3 call. |
| **S2** External stdio MCP servers (Playwright + user-configured) | stdio subprocess | config `tools.mcpServers` ([`disclaude.config.example.yaml:249`](../disclaude.config.example.yaml)); loader `mcp-setup.ts` | **CLI Skills.** This is the primary target — Playwright is the reference migration ([#4460](https://github.com/hs3180/disclaude/issues/4460), PR #4464). |
| **S3** `@disclaude/mcp-server` exported as a standalone stdio server | stdio | [`packages/mcp-server/src/cli.ts`](../packages/mcp-server/src/cli.ts) (`disclaude-mcp`) | **Open.** Exported surface for external MCP clients (e.g. Claude Code). Deprecate, or expose the same tools as CLI Skills. Scope 3/4 decides. |

**What this spec fixes** (so scope 3 doesn't have to): for any surface that migrates to a CLI Skill
(S2 certainly; S1/S3 possibly), the `cli.mjs` + `README.md` it produces conforms to
[§2](#2-cli-invocation-contract)–[§4](#4-artifact-contract). The inline-tool adapter (#4387) is the
*other* retained tool path (in-process, not a CLI) and is explicitly **out of scope** for retirement
([#4459](https://github.com/hs3180/disclaude/issues/4459): *"保留 inline-tool adapter #4387"*).

---

## 6. Reference implementation

`skills/playwright-agent/` (PR #4464) is the canonical CLI Skill:

- `cli.mjs` — subcommands (`screenshot` / `snapshot` / `extract` / `eval` one-shot, `script` multi-step),
  `--steps '<JSON>' | @FILE` for large input, `--session <file>` for state continuity.
- emits exactly one JSON object: `{"ok":true,"command":…,"artifact":…,"durationMs":…}` /
  `{"ok":false,"command":…,"error":…,"hint":…}`.
- writes screenshots / snapshot JSON / `storageState` to disk artifacts; references them by path.
- `README.md` — Quick start, Commands table, Output contract, Artifacts, Runtime (host Playwright
  install + OS libs), Status (parity deferred to part 2).

New Skills should copy this structure and diverge only where their domain demands it.

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
