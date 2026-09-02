# channel Skill — Channel CLI

> **Transport switch ([#4532](https://github.com/hs3180/disclaude/issues/4532)
> part 1, owner ruling 2026-08-18):** the CLI now reaches the PrimaryNode over
> the **REST API** (HttpApiServer `/api/send-message`, `/api/send-card`,
> `/api/upload-file`, `/api/send-interactive`, `/api/push`) — it no longer opens
> a Unix socket, and there is **no IPC fallback** on the CLI path. The CLI sets
> `DISCLAUDE_REST_IPC_ENABLED=true` internally before executing a send path, so every send path — including `send_card`'s
> local-image upload (`resolveCardImages` → `getIpcClient()`) — selects
> `RestIpcClient`. Base URL: `--base-url` > `DISCLAUDE_REST_IPC_BASE_URL` >
> `http://localhost:19200`. Bearer token: `DISCLAUDE_REST_IPC_API_TOKEN` (unset
> is fine when the PrimaryNode runs without `--api-token`). When the REST face
> is unreachable, the CLI emits an actionable "start the main service" hint
> instead of a raw `fetch` ECONNREFUSED (#4532 scope 3). The #4521 chatId
> pre-check substance was re-landed on the REST CLI by part 11 (see §Parity).
> The Unix-socket IPC face itself is
> deprecated for this consumer and will be removed in #4280 (Phase 3).

> **Status (parts 3–7 + 11 of [#4459](https://github.com/hs3180/disclaude/issues/4459)):**
> `send_text` (part 3, [#4467](https://github.com/hs3180/disclaude/pull/4467)),
> `send_file` (part 4, [#4494](https://github.com/hs3180/disclaude/pull/4494)),
> `send_card` (part 5), `push_to_agent` (part 6,
> [#4501](https://github.com/hs3180/disclaude/pull/4501)), and
> `send_interactive` (part 7) — **all 5 channel tools** migrated as CLI
> subcommands. **Part 11** (REST re-land of rejected
> [#4521](https://github.com/hs3180/disclaude/pull/4521)) closed the last code
> parity delta: the chatId _format_ pre-check the former MCP entry handler ran
> (#1641) now runs in every subcommand too, before any module import. All reuse
> the first-party implementations from `packages/channel-cli`; `send_card`
> additionally replicates the MCP entry handler's card preprocessing
> (GFM-table conversion, local-image auto-upload) for feature parity. **Live
> end-to-end parity** against the inline MCP tool is **deferred** (requires a
> running PrimaryNode + Feishu credentials) — these parts verify the command
> surface, validation, and graceful-degradation paths, mirroring how
> [#4464](https://github.com/hs3180/disclaude/pull/4464) part 1 deferred live
> browser parity. This README does **not** auto-close the parent issue.

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

# Send a display-only card from a JSON file (GFM tables / local images auto-handled)
node skills/channel/cli.mjs send_card --chat oc_xxx --card-file ./card.json

# ...or pipe the card JSON on stdin
echo '{"elements":[{"tag":"markdown","content":"hi"}]}' \
  | node skills/channel/cli.mjs send_card --chat oc_xxx
```

**Runtime (host deps, not bundled):** reuses `send_text` / `send_file` /
`send_card` (and the card preprocessing helpers) / `push_to_agent` /
`send_interactive` from `packages/channel-cli`, which talk to the PrimaryNode
over its REST API (#4532 — no Unix socket) and need Feishu credentials. Run
inside a disclaude workspace where the packages are built (`npm run build`), and
start the PrimaryNode with `--api-port`. No browser or extra binaries required.

## Commands

| Command            | Positional args | Options                                                                                                                                                                                  | Status    |
| ------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `send_text`        | —               | `--chat <id>` _(optional with default)_, `--text <string>`, `--text-file <path>`, `--parent <id>`, `--mentions <json>`                                                                   | ✅ part 3 |
| `send_card`        | —               | `--chat <id>` _(optional with default)_, `--card <json>`, `--card-file <path>`, `--parent <id>`                                                                                          | ✅ part 5 |
| `send_interactive` | —               | `--chat <id>` _(optional with default)_, `--question <string>` _(req)_, `--options <json>` _(req)_, `--title <string>`, `--context <string>`, `--action-prompts <json>`, `--parent <id>` | ✅ part 7 |
| `send_file`        | —               | `--chat <id>` _(optional with default)_, `--file <path>` _(req)_, `--parent <id>`                                                                                                        | ✅ part 4 |
| `push_to_agent`    | —               | `--chat <id>` _(optional with default)_, `--message <string>`, `--message-file <path>`                                                                                                   | ✅ part 6 |
| `help`             | —               | —                                                                                                                                                                                        | ✅        |

`--chat` in **every** command is resolved with this precedence: explicit
`--chat` > `FEISHU_CLI_CHAT_ID` > `feishu.cliChatId` in `disclaude.config.yaml`.
The resolved value is presence- **and format**-checked up front
(`oc_`/`ou_` ≥ 35 chars, `cli-` ≥ 5 — matching the former MCP entry-handler
rules, #1641); an ill-formed id fails before the send operation (part 11).

**Text input** — `--text "<string>"` for short content; `--text-file <path>` (or
`--text-file -` to read stdin explicitly) for larger bodies; or pipe on stdin
when no `--text`/`--text-file` is given and stdin is not a TTY. `push_to_agent`
follows the same rule for its instruction body (`--message` / `--message-file` /
piped stdin). This follows the Skill format spec §2.1 rule: never require the
agent to embed multi-KB text inline. `send_interactive` follows the same rule for its `--question`
(`--question` / `--question-file` / piped stdin); its `--options` is always a
JSON array flag (structured, not free text).

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
{"ok":true,"command":"send_interactive","chatId":"oc_xxx","result":"✅ Interactive message sent with 2 action(s)","optionCount":2,"durationMs":58}
{"ok":true,"command":"send_file","chatId":"oc_xxx","result":"✅ File sent: report.pdf (0.12 MB)","fileName":"report.pdf","fileSize":125952,"durationMs":310}
{"ok":true,"command":"send_card","chatId":"oc_xxx","result":"✅ Card message sent","durationMs":58}
{"ok":true,"command":"push_to_agent","chatId":"oc_xxx","result":"✅ Instruction pushed to agent successfully","durationMs":42}

// failure — exit 1
{"ok":false,"command":"send_text","error":"Missing required option --chat <id>","hint":"pass --chat oc_xxx"}
{"ok":false,"command":"send_text","error":"Invalid chatId: Invalid chatId format: \"not-a-chat-id\"\nExpected one of the following formats:\n- `oc_...` (Feishu group chat)\n- `ou_...` (Feishu user (p2p chat))\n- `cli-...` (CLI session)"}
{"ok":false,"command":"send_interactive","error":"options must be a non-empty array"}
{"ok":false,"command":"send_interactive","error":"Invalid --options JSON: ..."}
{"ok":false,"command":"send_file","error":"Missing required option --file <path>","hint":"pass --file <path> (relative paths resolve against the workspace dir)"}
{"ok":false,"command":"send_card","error":"Invalid card JSON: Unexpected token ...","hint":"pass --card <json>, --card-file <path>, or pipe card JSON on stdin"}
{"ok":false,"command":"send_card","error":"Invalid card structure: ..."}
{"ok":false,"command":"push_to_agent","error":"Missing message content","hint":"pass --message <string>, --message-file <path>, or pipe content on stdin"}
{"ok":false,"command":"send_text","error":"IPC service unavailable. Please ensure Primary Node is running.","hint":"PrimaryNode REST http://localhost:19200 unreachable — start the main service (disclaude-primary start --api-port <port>) or pass --base-url / DISCLAUDE_REST_IPC_BASE_URL"}
{"ok":false,"command":"send_text","error":"Failed to load channel implementation: ...","hint":"run inside a disclaude workspace with packages built (npm run build); ..."}
```

Failure modes covered: missing/invalid args, unreadable `--text-file` /
`--card-file` / `--question-file` / `--message-file`, malformed `--mentions` / `--card` /
`--options` / `--action-prompts` JSON, non-object card, invalid card structure,
invalid chatId format (**every** subcommand, part 11 — same check as the MCP
entry handlers, run pre-import), invalid option structure (empty `text`/`value`, bad
`type`), channel implementation not built/resolvable, REST face unreachable
(PrimaryNode not started / port not open — reported with an actionable hint),
and REST send failure (the underlying first-party tools map these to `SendMessageResult` /
`SendInteractiveResult` / `{ success:false, error, message }` results).

## Artifacts

None. `send_text`, `push_to_agent`, and `send_interactive` are side-effect-free
on the local filesystem — they reach the PrimaryNode over its REST API and
return. `send_file` **reads** the local file at `--file` (uploaded over REST)
and writes
nothing. No files are written by any command. (`push_to_agent` does have an
intended _remote_ side effect — it pushes an instruction that may
create/lazily-resume the target chat's agent.)

## Runtime

| Dependency                                                                                                                   | Source                                                          | How to satisfy                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/channel-cli` (channel operations and card helpers) | workspace package                                               | build the monorepo (`npm run build`)                                                                                                    |
| disclaude PrimaryNode (**REST API**, #4532)                                                                                  | runtime                                                         | start it with `--api-port` (e.g. `19200`); the CLI POSTs to `/api/*` — no Unix socket involved                                          |
| REST base URL                                                                                                                | `--base-url` flag > `DISCLAUDE_REST_IPC_BASE_URL` env > default | default `http://localhost:19200`; the env var reaches one-shot CLI processes via the agent runtime env (`.runtime-env`, Issue #1361)    |
| REST bearer token                                                                                                            | `DISCLAUDE_REST_IPC_API_TOKEN` env                              | required only when the PrimaryNode was started with `--api-token` (pass the same secret)                                                |
| Feishu credentials                                                                                                           | `disclaude.config.yaml` / env                                   | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` (validated inside `send_text` / `send_file` / `send_card` / `push_to_agent` / `send_interactive`) |

**Same-host constraint of the file-carrying routes (#4532 review note):** the
REST file contract is path-based, not content-based — `send_file` and
`send_card`'s local-image auto-upload send a **file path** to
`/api/upload-file` / `/api/upload-image`, and the PrimaryNode reads that path
from **its own filesystem** (exact IPC parity; see the server-side "local
filePath" contract in `http-api-server.ts`). Pointing `--base-url` at a
PrimaryNode on another host therefore works for `send_text` /
`send_interactive` / `push_to_agent` but makes `send_file` fail server-side
(ENOENT) and degrades card local images to placeholders. This is a limitation
of the current endpoint contract (inherited from IPC, where same-host was
implicit), not of the transport switch; relaxing it (multipart / base64 upload)
is deferred with the endpoint work, not the CLI.

If the channel implementation cannot be loaded, the CLI emits a failure JSON with
a build hint rather than crashing (analogous to #4464's missing-`playwright`
hint). If the PrimaryNode REST face is unavailable (service not started / port
not open), `send_text` / `send_file` / `send_card` / `push_to_agent` /
`send_interactive` surface that, and the CLI relays it as a failure JSON with
the actionable hint `PrimaryNode REST <url> unreachable — start the main service
…` (#4532 scope 3) instead of a bare `fetch` ECONNREFUSED.

## Parity / migration notes

Recorded explicitly per #4459 acceptance ("迁移/下线不静默"):

| Aspect                     | MCP tool (S1)                                                     | This CLI Skill                                                                                                                                              | Delta                                                      |
| -------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Transport                  | in-process MCP tool dispatch                                      | one-shot process, shells out via `Bash`                                                                                                                     | different transport, same first-party impl                 |
| IPC reach-back             | in-process `getIpcClient()` (Unix socket by default)              | `getIpcClient()` with `DISCLAUDE_REST_IPC_ENABLED=true` forced → `RestIpcClient` → HttpApiServer `/api/*` (#4532)                                           | REST only — no Unix socket, no IPC fallback                |
| `send_text` parameters     | `text`, `chatId`, `parentMessageId`, `mentions`                   | identical, via `--chat`/`--text`/`--text-file`/`--parent`/`--mentions`                                                                                      | text gains `--text-file`/stdin for large bodies            |
| `send_file` parameters     | `filePath`, `chatId`, `parentMessageId`                           | identical, via `--file`/`--chat`/`--parent` (relative `--file` resolves against the workspace dir, as in the MCP tool)                                      | none                                                       |
| `push_to_agent` parameters | `chatId`, `message`                                               | identical, via `--chat`/`--message`/`--message-file`                                                                                                        | message gains `--message-file`/stdin for long instructions |
| chatId format pre-check    | `getChatIdValidationError(chatId)` in every entry handler (#1641) | identical check in every subcommand (part 11) — all five pre-import via the twin in `cli.mjs`; `send_card` re-runs the exported helper post-import (part 5) | none                                                       |
| Capability gating          | MCP layer gates on `supportedMcpTools` per chat                   | **not** gated here — the agent invokes the CLI at its own discretion                                                                                        | see open item below                                        |
| Logging                    | pino → stdout (in-process, acceptable)                            | pino → **stderr** for the call's duration (stdout reserved for the result JSON)                                                                             | none functionally                                          |

`send_interactive` (part 7) parity is the same shape, with one extra note worth
recording explicitly: the first-party `send_interactive_message` is a **pure
forwarding client** — it passes the raw `question`/`options`/`title`/`context`/
`actionPrompts` to the PrimaryNode via the `sendInteractive` IPC, and the
**PrimaryNode** builds the card, sends it, and registers the button-click action
prompts (`packages/channel-cli/src/tools/interactive-message.ts`, #1571/#1572).
Button handling therefore lives on the PrimaryNode side and is **not** part of
this one-shot CLI — the CLI never starts an IPC server or owns a button handler,
exactly like `send_text`. Parameters map 1:1 via `--chat`/`--question`/
`--question-file`/`--options`/`--title`/`--context`/`--action-prompts`/`--parent`.

**Open item deferred to a later part / owner input (not resolved here):** the MCP
`channel-mcp` surface is gated per-chat on `supportedMcpTools`
(`packages/primary-node/src/channels/channel-descriptors.ts`). A CLI is invoked at the
agent's discretion, so moving to a CLI loses that per-chat capability filter
unless it is re-imposed elsewhere. The `send_text` / `send_file` / `send_card` /
`push_to_agent` migrations do **not** re-impose it; the inventory flags this as open question 2
(`docs/mcp-server-inventory.md`). Resolving it consistently across all 5 tools is
left to a later part of #4459 once the full surface is migrated.

**`push_to_agent` (part 6) parity** — its MCP entry handler
the former channel-mcp entry handler was the bare first-party
`push_to_agent` function preceded only by a `getChatIdValidationError(chatId)`
format check. Parts 3–6 initially **deferred** the chatId _format_ check to a
presence-only validation (an ill-formed id was still rejected, but by the
transport layer rather than up front) — the deferred-parity item `send_text`
carried. **Part 11 closed that delta**: every subcommand now runs the same
format pre-check as the handlers before any import (`parseChatId` in
`cli.mjs`). No card/table/image transforms apply to `push_to_agent`, so unlike
`send_card` it needs no extra helper exports.

**#4521 chatId pre-check ruling (#4532 acceptance, explicit — migration is not
silent):** PR #4521 (chatId-format pre-checks on all 5 subcommands) was
direction-rejected because it was built on the IPC foundation; its substance is
transport-independent. #4532's acceptance item — _"the pre-check's fate on the
REST CLI is explicitly decided"_ — is now settled by **part 11**: **kept, and
extended to all 5 subcommands**. Every subcommand runs the format pre-check
**pre-import** via a twin of the exported pattern table (`parseChatId` in
`cli.mjs`; byte-identical rules to `getChatIdValidationError`), so an
ill-formed id fails cheaply before the channel implementation is loaded. This
matters _more_ on REST than it did on IPC: the REST handlers validate `chatId`
as a non-empty string only (`/api/send-message` et al.), so without the twin an
ill-formed id would surface as a confusing Feishu 4xx deep behind the server.
`send_card` additionally re-runs the exported helper post-import (part 5,
unchanged shape) — if the twin and the authoritative validator ever disagree,
the authoritative one wins.

**`send_card` parity (part 5) — preprocessing is replicated, not dropped.** The
first-party `send_card` fn does **not** itself apply GFM-table conversion
(#2340) or local-image auto-upload (#2951) — those transforms live in the
former `channel-mcp` entry handler. A naïve
"call `send_card` directly" CLI would silently drop both features. Instead
`cmdSendCard` runs the **same pipeline** as the handler, using helpers now
implemented in `packages/channel-cli` (`transformCardTables`,
`resolveCardImages`, `detectMarkdownTableWarnings`, `isValidFeishuCard`,
`getCardValidationError`, `getChatIdValidationError`):

| Aspect                   | MCP `send_card` (S1)                                             | This CLI Skill                                            | Delta                                           |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Card preprocessing       | `transformCardTables` → `resolveCardImages` in the entry handler | identical pipeline in `cmdSendCard`, same helpers         | none                                            |
| GFM tables (#2340)       | auto-converted to `column_set`                                   | auto-converted; success result annotates the conversion   | none                                            |
| Local images (#2951)     | auto-uploaded, paths → `image_key`                               | auto-uploaded via `resolveCardImages`; counts annotated   | none                                            |
| Card / chatId validation | `isValidFeishuCard`, `getChatIdValidationError` in handler       | identical checks, same helpers, before any IPC            | none                                            |
| Parameters               | `card`, `chatId`, `parentMessageId`                              | identical, via `--chat`/`--card`/`--card-file`/`--parent` | card gains `--card-file`/stdin for large bodies |

**Out of scope for these parts:** live end-to-end delivery verification (needs
PrimaryNode + creds); the S2 external-MCP-loader removal (#4459 scope 4, gated
on the Playwright migration #4460).
