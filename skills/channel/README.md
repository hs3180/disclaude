# channel Skill — CLI replacement for `channel-mcp` (#4459)

> **Status (parts 3–4 of [#4459](https://github.com/hs3180/disclaude/issues/4459)):**
> `send_text` (part 3, [#4467](https://github.com/hs3180/disclaude/pull/4467)) and
> `send_file` (part 4) command surfaces + output contract implemented (both reuse
> the first-party implementations from `@disclaude/mcp-server` over IPC). **Live
> end-to-end parity** against the inline MCP tool is **deferred** (requires a
> running PrimaryNode + Feishu credentials) — these parts verify the command
> surface, validation, and graceful-degradation paths, mirroring how
> [#4464](https://github.com/hs3180/disclaude/pull/4464) part 1 deferred live
> browser parity. The remaining 3 channel tools (`send_card`, `send_interactive`,
> `push_to_agent`) are deferred to later parts. This README does
> **not** auto-close the parent issue.

A **CLI Skill** under disclaude's "reduce MCP" direction
([#4383](https://github.com/hs3180/disclaude/issues/4383), owner decision
2026-08-07). It is the Skills (CLI + README) replacement for the inline
`channel-mcp` MCP server (surface **S1** in
[`docs/mcp-server-inventory.md`](../../docs/mcp-server-inventory.md)), which
exposes the 5 first-party channel tools (`send_text`, `send_card`,
`send_interactive`, `send_file`, `push_to_agent`). The agent drives this CLI via
`Bash` instead of the runtime dispatching an in-process MCP tool — see
[`docs/skill-format-spec.md`](../../docs/skill-format-spec.md) for the contract.

This is a **CLI Skill** (a `cli.mjs` the agent shells out to), distinct from the
existing `SKILL.md` agent-skills. The two coexist; an agent-skill may shell out
to this CLI as one of its tools.

## Quick start

```bash
# Send a plain text message
node skills/channel/cli.mjs send_text --chat oc_xxx --text "Hello, world!"

# Pipe a longer body on stdin
echo "status: all green" | node skills/channel/cli.mjs send_text --chat oc_xxx

# Read text from a file + reply in a thread
node skills/channel/cli.mjs send_text --chat oc_xxx --text-file ./msg.md --parent om_root

# @-mention a user
node skills/channel/cli.mjs send_text --chat oc_xxx --text "pls review" \
  --mentions '[{"openId":"ou_yyy","name":"owner"}]'

# Send a file (relative paths resolve against the workspace dir)
node skills/channel/cli.mjs send_file --chat oc_xxx --file ./report.pdf

# Send a file as a thread reply
node skills/channel/cli.mjs send_file --chat oc_xxx --file ./log.txt --parent om_root
```

**Runtime (host deps, not bundled):** reuses `send_text` / `send_file` from
`@disclaude/mcp-server`, which talk to the PrimaryNode over IPC and need Feishu
credentials. Run inside a disclaude workspace where the packages are built
(`npm run build`). No browser or extra binaries required.

## Commands

| Command | Positional args | Options | Status |
|---|---|---|---|
| `send_text` | — | `--chat <id>` *(req)*, `--text <string>`, `--text-file <path>`, `--parent <id>`, `--mentions <json>` | ✅ part 3 |
| `send_card` | — | — | ⏳ deferred (#4459 later part) |
| `send_interactive` | — | — | ⏳ deferred (#4459 later part) |
| `send_file` | — | `--chat <id>` *(req)*, `--file <path>` *(req)*, `--parent <id>` | ✅ part 4 |
| `push_to_agent` | — | — | ⏳ deferred (#4459 later part) |
| `help` | — | — | ✅ |

**Text input** — `--text "<string>"` for short content; `--text-file <path>` (or
`--text-file -` to read stdin explicitly) for larger bodies; or pipe on stdin
when no `--text`/`--text-file` is given and stdin is not a TTY. This follows the
Skill format spec §2.1 rule: never require the agent to embed multi-KB text
inline.

**Options** are long-form only (`--flag` / `--opt VALUE`), per spec §2.1.

## Output contract

Every command prints **exactly one JSON object** to stdout and nothing else
(spec §2.2). Diagnostics and logs go to stderr. Exit code is `0` on success,
`1` on failure.

```jsonc
// success — exit 0
{"ok":true,"command":"send_text","chatId":"oc_xxx","result":"✅ Text message sent","durationMs":42}
{"ok":true,"command":"send_file","chatId":"oc_xxx","result":"✅ File sent: report.pdf (0.12 MB)","fileName":"report.pdf","fileSize":125952,"durationMs":310}

// failure — exit 1
{"ok":false,"command":"send_text","error":"Missing required option --chat <id>","hint":"pass --chat oc_xxx"}
{"ok":false,"command":"send_file","error":"Missing required option --file <path>","hint":"pass --file <path> (relative paths resolve against the workspace dir)"}
{"ok":false,"command":"send_text","error":"IPC service unavailable. Please ensure Primary Node is running.","hint":"ensure the disclaude PrimaryNode is running and IPC is reachable"}
{"ok":false,"command":"send_text","error":"Failed to load @disclaude/mcp-server: ...","hint":"run inside a disclaude workspace with packages built (npm run build); ..."}
```

Failure modes covered: missing/invalid args, unreadable `--text-file`, malformed
`--mentions` JSON, `@disclaude/mcp-server` not built/resolvable, IPC
unreachable, and IPC send failure (the underlying `send_text` / `send_file`
already map these to `{ success:false, error, message }` results).

## Artifacts

None. `send_text` is side-effect-free on the local filesystem — it sends a
message over IPC and returns. `send_file` **reads** the local file at `--file`
(uploaded over IPC) and writes nothing. No files are written by either command.

## Runtime

| Dependency | Source | How to satisfy |
|---|---|---|
| `@disclaude/mcp-server` (exports `send_text`, `send_file`) | workspace package | build the monorepo (`npm run build`) |
| disclaude PrimaryNode (IPC) | runtime | run disclaude; the CLI reaches `getIpcClient()` over the Unix/REST IPC transport |
| Feishu credentials | `disclaude.config.yaml` / env | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` (validated inside `send_text` / `send_file`) |

If `@disclaude/mcp-server` cannot be imported, the CLI emits a failure JSON with
a build hint rather than crashing (analogous to #4464's missing-`playwright`
hint). If the PrimaryNode / IPC is unavailable, `send_text` / `send_file`
surface that and the CLI relays it as a failure JSON.

## Parity / migration notes

Recorded explicitly per #4459 acceptance ("迁移/下线不静默"):

| Aspect | MCP tool (S1) | This CLI Skill | Delta |
|---|---|---|---|
| Transport | in-process MCP tool dispatch | one-shot process, shells out via `Bash` | different transport, same first-party impl |
| IPC reach-back | in-process `getIpcClient()` | same `getIpcClient()`, from a separate process (as the S3 standalone server already does) | none at the impl layer |
| `send_text` parameters | `text`, `chatId`, `parentMessageId`, `mentions` | identical, via `--chat`/`--text`/`--text-file`/`--parent`/`--mentions` | text gains `--text-file`/stdin for large bodies |
| `send_file` parameters | `filePath`, `chatId`, `parentMessageId` | identical, via `--file`/`--chat`/`--parent` (relative `--file` resolves against the workspace dir, as in the MCP tool) | none |
| Capability gating | MCP layer gates on `supportedMcpTools` per chat | **not** gated here — the agent invokes the CLI at its own discretion | see open item below |
| Logging | pino → stdout (in-process, acceptable) | pino → **stderr** for the call's duration (stdout reserved for the result JSON) | none functionally |

**Open item deferred to a later part / owner input (not resolved here):** the MCP
`channel-mcp` surface is gated per-chat on `supportedMcpTools`
(`packages/primary-node/src/agents/mcp-setup.ts:45-52`). A CLI is invoked at the
agent's discretion, so moving to a CLI loses that per-chat capability filter
unless it is re-imposed elsewhere. This first `send_text` migration does **not**
re-impose it; the inventory flags this as open question 2
(`docs/mcp-server-inventory.md`). Resolving it consistently across all 5 tools is
left to a later part of #4459 once the full surface is migrated.

**Out of scope for this part:** `send_card`, `send_interactive`,
`push_to_agent` (follow the same subcommand pattern here); live end-to-end
delivery verification (needs PrimaryNode + creds); the S2 external-MCP-loader
removal (#4459 scope 4, gated on the Playwright migration #4460).
