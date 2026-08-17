# channel Skill — CLI replacement for `channel-mcp` (#4459)

> **Status (parts 3–4, 6–7 of [#4459](https://github.com/hs3180/disclaude/issues/4459)):**
> `send_text` (part 3, [#4467](https://github.com/hs3180/disclaude/pull/4467)),
> `send_file` (part 4), `push_to_agent` (part 6), and `send_interactive` (part 7)
> command surfaces + output contracts implemented (each reuses its first-party
> implementation from
> `@disclaude/mcp-server` over IPC). **Live end-to-end parity** against the inline
> MCP tool is **deferred** (requires a running PrimaryNode + Feishu credentials) —
> these parts verify the command surface, validation, and graceful-degradation
> paths, mirroring how [#4464](https://github.com/hs3180/disclaude/pull/4464) part
> 1 deferred live browser parity. The remaining channel tool (`send_card`)
> is deferred to a later part. This README does
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

# Send an interactive card with buttons (PrimaryNode builds the card; button
# clicks are routed back to the agent as prompts)
node skills/channel/cli.mjs send_interactive --chat oc_xxx \
  --question "Which option do you prefer?" \
  --options '[{"text":"Approve","value":"approve","type":"primary"},
              {"text":"Reject","value":"reject","type":"danger"}]' \
  --title "Code Review"

# Pipe a longer question on stdin + custom action prompts
echo "Deploy to prod?" | node skills/channel/cli.mjs send_interactive --chat oc_xxx \
  --options '[{"text":"yes","value":"yes"},{"text":"no","value":"no"}]' \
  --action-prompts '{"yes":"[user] approved deploy","no":"[user] rejected deploy"}'

# Send a file (relative paths resolve against the workspace dir)
node skills/channel/cli.mjs send_file --chat oc_xxx --file ./report.pdf

# Send a file as a thread reply
node skills/channel/cli.mjs send_file --chat oc_xxx --file ./log.txt --parent om_root

# Push an instruction to the agent handling a chat (agent is created lazily)
node skills/channel/cli.mjs push_to_agent --chat oc_xxx --message "Summarize unread messages"

# Pipe a longer instruction on stdin
echo "Reply to the open question in this thread." | node skills/channel/cli.mjs push_to_agent --chat oc_xxx
```

**Runtime (host deps, not bundled):** reuses `send_text` / `send_file` /
`push_to_agent` / `send_interactive` from `@disclaude/mcp-server`, which talk to
the PrimaryNode over IPC and need Feishu credentials. Run inside a disclaude
workspace where the packages are built (`npm run build`). No browser or extra
binaries required.

## Commands

| Command | Positional args | Options | Status |
|---|---|---|---|
| `send_text` | — | `--chat <id>` *(req)*, `--text <string>`, `--text-file <path>`, `--parent <id>`, `--mentions <json>` | ✅ part 3 |
| `send_file` | — | `--chat <id>` *(req)*, `--file <path>` *(req)*, `--parent <id>` | ✅ part 4 |
| `push_to_agent` | — | `--chat <id>` *(req)*, `--message <string>`, `--message-file <path>` | ✅ part 6 |
| `send_interactive` | — | `--chat <id>` *(req)*, `--question <string>` *(req)*, `--options <json>` *(req)*, `--title <string>`, `--context <string>`, `--action-prompts <json>`, `--parent <id>` | ✅ part 7 |
| `send_card` | — | — | ⏳ deferred (#4459 later part) |
| `help` | — | — | ✅ |

**Text input** — `--text "<string>"` for short content; `--text-file <path>` (or
`--text-file -` to read stdin explicitly) for larger bodies; or pipe on stdin
when no `--text`/`--text-file` is given and stdin is not a TTY. `push_to_agent`
follows the same rule with `--message` / `--message-file`. This follows the
Skill format spec §2.1 rule: never require the agent to embed multi-KB text
inline. `send_interactive` follows the same rule for its `--question`
(`--question` / `--question-file` / piped stdin); its `--options` is always a
JSON array flag (structured, not free text).

**Options** are long-form only (`--flag` / `--opt VALUE`), per spec §2.1.

## Output contract

Every command prints **exactly one JSON object** to stdout and nothing else
(spec §2.2). Diagnostics and logs go to stderr. Exit code is `0` on success,
`1` on failure.

```jsonc
// success — exit 0
{"ok":true,"command":"send_text","chatId":"oc_xxx","result":"✅ Text message sent","durationMs":42}
{"ok":true,"command":"send_interactive","chatId":"oc_xxx","result":"✅ Interactive message sent with 2 action(s)","optionCount":2,"durationMs":58}
{"ok":true,"command":"send_file","chatId":"oc_xxx","result":"✅ File sent: report.pdf (0.12 MB)","fileName":"report.pdf","fileSize":125952,"durationMs":310}
{"ok":true,"command":"push_to_agent","chatId":"oc_xxx","result":"✅ Instruction pushed to agent successfully","durationMs":42}

// failure — exit 1
{"ok":false,"command":"send_text","error":"Missing required option --chat <id>","hint":"pass --chat oc_xxx"}
{"ok":false,"command":"send_interactive","error":"options must be a non-empty array"}
{"ok":false,"command":"send_interactive","error":"Invalid --options JSON: ..."}
{"ok":false,"command":"send_file","error":"Missing required option --file <path>","hint":"pass --file <path> (relative paths resolve against the workspace dir)"}
{"ok":false,"command":"send_text","error":"IPC service unavailable. Please ensure Primary Node is running.","hint":"ensure the disclaude PrimaryNode is running and IPC is reachable"}
{"ok":false,"command":"send_text","error":"Failed to load @disclaude/mcp-server: ...","hint":"run inside a disclaude workspace with packages built (npm run build); ..."}
{"ok":false,"command":"push_to_agent","error":"Missing message content","hint":"pass --message <string>, --message-file <path>, or pipe content on stdin"}
```

Failure modes covered: missing/invalid args, unreadable `--text-file` /
`--question-file` / `--message-file`, malformed
`--mentions`/`--options`/`--action-prompts` JSON, invalid option structure (empty
`text`/`value`, bad `type`), `@disclaude/mcp-server` not built/resolvable, IPC
unreachable, and IPC send failure (the underlying first-party tools already map
these to `SendMessageResult` / `SendInteractiveResult` /
send-file `{ success:false, error, message }` results).

## Artifacts

None. `send_text`, `push_to_agent`, and `send_interactive` are side-effect-free
on the local filesystem — they reach the PrimaryNode over IPC and return.
`send_file` **reads** the local file at `--file` (uploaded over IPC) and writes
nothing. No files are written by any command. (`push_to_agent` does have an
intended *remote* side effect — it pushes an instruction that may
create/lazily-resume the target chat's agent.)

## Runtime

| Dependency | Source | How to satisfy |
|---|---|---|
| `@disclaude/mcp-server` (exports `send_text`, `send_file`, `push_to_agent`, `send_interactive`) | workspace package | build the monorepo (`npm run build`) |
| disclaude PrimaryNode (IPC) | runtime | run disclaude; the CLI reaches `getIpcClient()` over the Unix/REST IPC transport |
| Feishu credentials | `disclaude.config.yaml` / env | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` (validated inside `send_text` / `send_file` / `send_interactive`) |

If `@disclaude/mcp-server` cannot be imported, the CLI emits a failure JSON with
a build hint rather than crashing (analogous to #4464's missing-`playwright`
hint). If the PrimaryNode / IPC is unavailable, `send_text` / `send_file` /
`push_to_agent` / `send_interactive` surface that and the CLI relays it as a
failure JSON.

## Parity / migration notes

Recorded explicitly per #4459 acceptance ("迁移/下线不静默"):

| Aspect | MCP tool (S1) | This CLI Skill | Delta |
|---|---|---|---|
| Transport | in-process MCP tool dispatch | one-shot process, shells out via `Bash` | different transport, same first-party impl |
| IPC reach-back | in-process `getIpcClient()` | same `getIpcClient()`, from a separate process (as the S3 standalone server already does) | none at the impl layer |
| `send_text` parameters | `text`, `chatId`, `parentMessageId`, `mentions` | identical, via `--chat`/`--text`/`--text-file`/`--parent`/`--mentions` | text gains `--text-file`/stdin for large bodies |
| `send_file` parameters | `filePath`, `chatId`, `parentMessageId` | identical, via `--file`/`--chat`/`--parent` (relative `--file` resolves against the workspace dir, as in the MCP tool) | none |
| `push_to_agent` parameters | `chatId`, `message` | identical, via `--chat`/`--message`/`--message-file` | message gains `--message-file`/stdin for long instructions |
| Capability gating | MCP layer gates on `supportedMcpTools` per chat | **not** gated here — the agent invokes the CLI at its own discretion | see open item below |
| Logging | pino → stdout (in-process, acceptable) | pino → **stderr** for the call's duration (stdout reserved for the result JSON) | none functionally |

**`push_to_agent` (part 6) parity** — its MCP entry handler
(`packages/mcp-server/src/channel-mcp.ts`) is the bare first-party
`push_to_agent` function preceded only by a `getChatIdValidationError(chatId)`
format check. This CLI calls `push_to_agent()` directly and, like `send_text`
above, **defers** the chatId *format* check to a presence-only validation; an
ill-formed id is still rejected, but by the IPC layer rather than up front. This
is the same deferred-parity item `send_text` carries (resolving it once, across
all subcommands, is left to a later part of #4459). No card/table/image
transforms apply to `push_to_agent`, so unlike `send_card` it needs no extra
helper exports from `@disclaude/mcp-server`.

`send_interactive` (part 7) parity is the same shape, with one extra note worth
recording explicitly: the first-party `send_interactive_message` is a **pure
forwarding client** — it passes the raw `question`/`options`/`title`/`context`/
`actionPrompts` to the PrimaryNode via the `sendInteractive` IPC, and the
**PrimaryNode** builds the card, sends it, and registers the button-click action
prompts (`packages/mcp-server/src/tools/interactive-message.ts`, #1571/#1572).
Button handling therefore lives on the PrimaryNode side and is **not** part of
this one-shot CLI — the CLI never starts an IPC server or owns a button handler,
exactly like `send_text`. Parameters map 1:1 via `--chat`/`--question`/
`--question-file`/`--options`/`--title`/`--context`/`--action-prompts`/`--parent`.

**Open item deferred to a later part / owner input (not resolved here):** the MCP
`channel-mcp` surface is gated per-chat on `supportedMcpTools`
(`packages/primary-node/src/agents/mcp-setup.ts:45-52`). A CLI is invoked at the
agent's discretion, so moving to a CLI loses that per-chat capability filter
unless it is re-imposed elsewhere. This first `send_text` migration does **not**
re-impose it; the inventory flags this as open question 2
(`docs/mcp-server-inventory.md`). Resolving it consistently across all 5 tools is
left to a later part of #4459 once the full surface is migrated.

**Out of scope for these parts:** `send_card`
(follow the same subcommand pattern here); live end-to-end delivery verification
(needs PrimaryNode + creds); the S2 external-MCP-loader removal (#4459 scope 4,
gated on the Playwright migration #4460).
