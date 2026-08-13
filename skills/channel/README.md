# channel Skill — CLI replacement for `channel-mcp` (#4459)

> **Status (parts 3 & 5 of [#4459](https://github.com/hs3180/disclaude/issues/4459)):**
> `send_text` (part 3) and `send_card` (part 5) command surfaces + output
> contracts are implemented. Both reuse the first-party implementations from
> `@disclaude/mcp-server` over IPC; `send_card` additionally replicates the MCP
> entry handler's card preprocessing (GFM-table conversion, local-image
> auto-upload) for feature parity. **Live end-to-end parity** against the inline
> MCP tool is **deferred** (requires a running PrimaryNode + Feishu credentials)
> — these parts verify the command surface, validation, and graceful-degradation
> paths, mirroring how [#4464](https://github.com/hs3180/disclaude/pull/4464)
> part 1 deferred live browser parity. The remaining 3 channel tools
> (`send_interactive`, `send_file`, `push_to_agent`) are deferred to later parts
> (`send_file` is part 4, PR #4494, open). This README does **not** auto-close
> the parent issue.

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

# Send a display-only card from a JSON file (GFM tables / local images auto-handled)
node skills/channel/cli.mjs send_card --chat oc_xxx --card-file ./card.json

# ...or pipe the card JSON on stdin
echo '{"elements":[{"tag":"markdown","content":"hi"}]}' \
  | node skills/channel/cli.mjs send_card --chat oc_xxx
```

**Runtime (host deps, not bundled):** reuses `send_text` / `send_card` (and the
card preprocessing helpers) from `@disclaude/mcp-server`, which talks to the
PrimaryNode over IPC and needs Feishu credentials. Run inside a disclaude
workspace where the packages are built (`npm run build`). No browser or extra
binaries required.

## Commands

| Command | Positional args | Options | Status |
|---|---|---|---|
| `send_text` | — | `--chat <id>` *(req)*, `--text <string>`, `--text-file <path>`, `--parent <id>`, `--mentions <json>` | ✅ part 3 |
| `send_card` | — | `--chat <id>` *(req)*, `--card <json>`, `--card-file <path>`, `--parent <id>` | ✅ part 5 |
| `send_interactive` | — | — | ⏳ deferred (#4459 later part) |
| `send_file` | — | — | ⏳ part 4 (PR #4494, open) |
| `push_to_agent` | — | — | ⏳ deferred (#4459 later part) |
| `help` | — | — | ✅ |

**Text input** — `--text "<string>"` for short content; `--text-file <path>` (or
`--text-file -` to read stdin explicitly) for larger bodies; or pipe on stdin
when no `--text`/`--text-file` is given and stdin is not a TTY. This follows the
Skill format spec §2.1 rule: never require the agent to embed multi-KB text
inline.

**Card input** — `--card "<json>"` for small cards; `--card-file <path>` (or
`--card-file -` to read stdin explicitly) for larger card JSON; or pipe on stdin
when no `--card`/`--card-file` is given and stdin is not a TTY. Same §2.1 rule:
never require the agent to embed a multi-KB card inline.

**Options** are long-form only (`--flag` / `--opt VALUE`), per spec §2.1.

## Output contract

Every command prints **exactly one JSON object** to stdout and nothing else
(spec §2.2). Diagnostics and logs go to stderr. Exit code is `0` on success,
`1` on failure.

```jsonc
// success — exit 0
{"ok":true,"command":"send_text","chatId":"oc_xxx","result":"✅ Text message sent","durationMs":42}
{"ok":true,"command":"send_card","chatId":"oc_xxx","result":"✅ Card message sent","durationMs":58}

// failure — exit 1
{"ok":false,"command":"send_text","error":"Missing required option --chat <id>","hint":"pass --chat oc_xxx"}
{"ok":false,"command":"send_card","error":"Invalid card JSON: Unexpected token ...","hint":"pass --card <json>, --card-file <path>, or pipe card JSON on stdin"}
{"ok":false,"command":"send_card","error":"Invalid card structure: ..."}
{"ok":false,"command":"send_card","error":"IPC service unavailable. Please ensure Primary Node is running.","hint":"ensure the disclaude PrimaryNode is running and IPC is reachable"}
{"ok":false,"command":"send_card","error":"Failed to load @disclaude/mcp-server: ...","hint":"run inside a disclaude workspace with packages built (npm run build); ..."}
```

Failure modes covered: missing/invalid args, unreadable `--text-file` /
`--card-file`, malformed `--mentions` / `--card` JSON, non-object card, invalid
card structure, invalid chatId format, `@disclaude/mcp-server` not
built/resolvable, IPC unreachable, and IPC send failure (the underlying
`send_text` / `send_card` map these to `SendMessageResult { success:false,
error, message }`).

## Artifacts

None. `send_text` is side-effect-free on the local filesystem — it sends a
message over IPC and returns. No files are written.

## Runtime

| Dependency | Source | How to satisfy |
|---|---|---|
| `@disclaude/mcp-server` (exports `send_text`, `send_card`, + card helpers) | workspace package | build the monorepo (`npm run build`) |
| disclaude PrimaryNode (IPC) | runtime | run disclaude; the CLI reaches `getIpcClient()` over the Unix/REST IPC transport |
| Feishu credentials | `disclaude.config.yaml` / env | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` (validated inside `send_text` / `send_card`) |

If `@disclaude/mcp-server` cannot be imported, the CLI emits a failure JSON with
a build hint rather than crashing (analogous to #4464's missing-`playwright`
hint). If the PrimaryNode / IPC is unavailable, `send_text` / `send_card` surface
that and the CLI relays it as a failure JSON.

## Parity / migration notes

Recorded explicitly per #4459 acceptance ("迁移/下线不静默"):

| Aspect | MCP `send_text` (S1) | This CLI Skill | Delta |
|---|---|---|---|
| Transport | in-process MCP tool dispatch | one-shot process, shells out via `Bash` | different transport, same first-party `send_text` impl |
| IPC reach-back | in-process `getIpcClient()` | same `getIpcClient()`, from a separate process (as the S3 standalone server already does) | none at the impl layer |
| Parameters | `text`, `chatId`, `parentMessageId`, `mentions` | identical, via `--chat`/`--text`/`--text-file`/`--parent`/`--mentions` | text gains `--text-file`/stdin for large bodies |
| Capability gating | MCP layer gates on `supportedMcpTools` per chat | **not** gated here — the agent invokes the CLI at its own discretion | see open item below |
| Logging | pino → stdout (in-process, acceptable) | pino → **stderr** for the call's duration (stdout reserved for the result JSON) | none functionally |

**Open item deferred to a later part / owner input (not resolved here):** the MCP
`channel-mcp` surface is gated per-chat on `supportedMcpTools`
(`packages/primary-node/src/agents/mcp-setup.ts:45-52`). A CLI is invoked at the
agent's discretion, so moving to a CLI loses that per-chat capability filter
unless it is re-imposed elsewhere. The `send_text` / `send_card` migrations do
**not** re-impose it; the inventory flags this as open question 2
(`docs/mcp-server-inventory.md`). Resolving it consistently across all 5 tools is
left to a later part of #4459 once the full surface is migrated.

**`send_card` parity (part 5) — preprocessing is replicated, not dropped.** The
first-party `send_card` fn does **not** itself apply GFM-table conversion
(#2340) or local-image auto-upload (#2951) — those transforms live in the
`channel-mcp` entry handler (`packages/mcp-server/src/channel-mcp.ts`). A naïve
"call `send_card` directly" CLI would silently drop both features. Instead
`cmdSendCard` runs the **same pipeline** as the handler, using helpers now
exported from `@disclaude/mcp-server` (`transformCardTables`,
`resolveCardImages`, `detectMarkdownTableWarnings`, `isValidFeishuCard`,
`getCardValidationError`, `getChatIdValidationError`):

| Aspect | MCP `send_card` (S1) | This CLI Skill | Delta |
|---|---|---|---|
| Card preprocessing | `transformCardTables` → `resolveCardImages` in the entry handler | identical pipeline in `cmdSendCard`, same helpers | none |
| GFM tables (#2340) | auto-converted to `column_set` | auto-converted; success result annotates the conversion | none |
| Local images (#2951) | auto-uploaded, paths → `image_key` | auto-uploaded via `resolveCardImages`; counts annotated | none |
| Card / chatId validation | `isValidFeishuCard`, `getChatIdValidationError` in handler | identical checks, same helpers, before any IPC | none |
| Parameters | `card`, `chatId`, `parentMessageId` | identical, via `--chat`/`--card`/`--card-file`/`--parent` | card gains `--card-file`/stdin for large bodies |

**Out of scope for this part:** `send_interactive`, `push_to_agent` (follow the
same subcommand pattern here); `send_file` is part 4 (PR #4494, open). Live
end-to-end delivery verification (needs PrimaryNode + creds); the S2
external-MCP-loader removal (#4459 scope 4, gated on the Playwright migration
#4460).
