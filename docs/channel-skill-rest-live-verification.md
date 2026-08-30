# channel Skill CLI — REST live end-to-end verification (#4532, part 2)

> **Status:** Live verification record — part 2 of
> [#4532](https://github.com/hs3180/disclaude/issues/4532) (scope 5), stacking
> on the transport switch shipped in part 1
> ([PR #4533](https://github.com/hs3180/disclaude/pull/4533)).
> This is the live-parity run #4459 had deferred since parts 3–7 ("requires a
> running PrimaryNode + Feishu credentials"), executed against the REST
> transport. Environment, commands, raw results, and one real-world finding
> (IPv6 loopback) are recorded below so the run is reproducible.

---

## 1. Environment

| Component | Value |
|---|---|
| Host | Linux container, Node `v22.23.1` |
| Repo state | PR #4533 head (`f207ba04`), `npm ci` + `npm run build` (tsc -b) |
| PrimaryNode | second instance: `node packages/primary-node/dist/cli.js start --config disclaude.config.yaml --api-port 9201` with `LOCKFILE_PATH=` (lockfile disabled — another PrimaryNode already runs in the container) and a scratch `LOG_DIR` |
| Channel | Feishu (real credentials from a local `disclaude.config.yaml`, appId `cli_a8a0…`; **not** committed) |
| Target chat | a real `oc_…` chat bound to this workspace |
| Transport | CLI → `RestIpcClient` → `HttpApiServer` (`/api/send-message`, `/api/send-card`, `/api/upload-file`, `/api/send-interactive`, `/api/push`). No Unix socket on the CLI path; the running default PrimaryNode's socket was irrelevant to these calls |

The one-shot CLI invocations used `--base-url` (flag path). The env-var path
(`DISCLAUDE_REST_IPC_BASE_URL`) is covered by part 1's unit tests; both resolve
identically in `wireRestTransport()` (named `resolveRestBaseUrl()` at the verified repo state `f207ba04`; renamed by post-run review fix `97820fe`).

## 2. Results — all 5 subcommands

| # | Subcommand | REST route | Result (stdout JSON) | Exit |
|---|---|---|---|---|
| 1 | `send_text` | `POST /api/send-message` | `{"ok":true,"command":"send_text","result":"✅ Text message sent","durationMs":562}` | 0 |
| 2 | `send_card` | `POST /api/send-card` | `{"ok":true,…,"result":"✅ Card message sent\n\nℹ️ Auto-converted a GFM table to column_set layout. …","durationMs":569}` | 0 |
| 3 | `send_file` | `POST /api/upload-file` | `{"ok":true,…,"result":"✅ File sent: issue4532-file.txt (0.00 MB)","fileName":"issue4532-file.txt","durationMs":1121}` | 0 |
| 4 | `send_interactive` | `POST /api/send-interactive` | `{"ok":true,…,"result":"✅ Interactive message sent with 2 action(s)","optionCount":2,"durationMs":576}` | 0 |
| 5 | `push_to_agent` | `POST /api/push` | `{"ok":true,…,"result":"✅ Instruction pushed to agent successfully","durationMs":122}` | 0 |

Parity details actually exercised:

- **`send_card` preprocessing pipeline ran on the REST path** — the card
  carried a GFM table in a markdown element and the result annotates the
  `column_set` auto-conversion (#2340), proving `transformCardTables` (and the
  image-resolution branch it shares the pipeline with, #2951) executed inside
  the one-shot CLI process whose `getIpcClient()` was REST-selected.
- **`send_interactive`** sent a 2-button card (button-click routing is owned by
  the PrimaryNode, as documented — the CLI is a one-shot client).
- **`push_to_agent`** reached the live agent (non-blocking enqueue, #631).

## 3. Error semantics (scope 3, re-verified live)

| Scenario | stdout | Exit |
|---|---|---|
| Server stopped after a successful send (`kill` the API-enabled PrimaryNode, re-run `send_text`) | `{"ok":false,…,"error":"IPC service unavailable. Please ensure Primary Node is running.","hint":"PrimaryNode REST http://[::1]:9201 unreachable — start the main service (disclaude-primary start --api-port <port>) or pass --base-url / DISCLAUDE_REST_IPC_BASE_URL"}` | 1 |
| Ill-formed chat id (`--chat bad_chat_id`, server up) | `{"ok":false,…,"error":"IPC_REQUEST_FAILED: REST sendMessage (Request failed with status code 400)"}` | 1 |

The down-server case shows the part-1 probe-based hint firing against a *real*
stopped server (not a unit-test ephemeral port): exactly one JSON object on
stdout, actionable hint naming the base URL, no raw `fetch` ECONNREFUSED.

## 4. Finding: `localhost` resolves differently for the server and Node `fetch` (IPv6)

One real environment issue surfaced during the run — recorded here because any
deployer reproducing this verification can hit it:

- `HttpApiServer` binds `host: 'localhost'`
  ([`packages/primary-node/src/http-api-server.ts:238`](../packages/primary-node/src/http-api-server.ts)
  default). On this host `/etc/hosts` maps `localhost` → `::1` **first** (then
  `127.0.0.1`), and Node's `net.Server.listen('localhost')` bound **IPv6
  loopback only** (`/proc/net/tcp6` shows the listener; nothing on `127.0.0.1`).
- Node `fetch` (undici) resolving `http://localhost:9201` tried `127.0.0.1`
  first and failed with `ECONNREFUSED` — repeatedly, deterministically (no
  happy-eyeballs fallback across families within the 2s probe timeout).
  `curl` succeeded because its resolver ordered `::1` first.
- Consequence: with `DISCLAUDE_REST_IPC_BASE_URL=http://localhost:19200` (the
  #4168 decision-3 default) on such a host, `isIpcAvailable()` and every REST
  call fail while `curl http://localhost:19200/api/ping` succeeds — a confusing
  split.
- Workarounds verified in this run: pass `--base-url 'http://[::1]:9201'`
  (used for all five successful sends above), or set
  `DISCLAUDE_REST_IPC_BASE_URL` accordingly, or bind the server explicitly to a
  single family (`--api-port` has no host flag today; the HttpApiServer config
  accepts `host`).

This is an environment/interop note, not a regression introduced by part 1 —
but it argues for either binding `127.0.0.1` explicitly or dual-stack listening
when #4280 makes REST the only transport. Left as an input to the owner; no
code change is bundled in this PR.

## 5. Verification hygiene

- The verification PrimaryNode was stopped after the run (`kill`); the
  container's default PrimaryNode (Unix-socket mode, no `--api-port`) was never
  touched.
- The target chat received 5 verification messages + 1 pushed instruction
  (labeled with the issue number in-text); no other chats were written.
- `disclaude.config.yaml` with real Feishu credentials was copied **into the
  scratch clone only** for the run (cwd-based config discovery) and is not part
  of this branch's diff.

## 6. Acceptance mapping (#4532)

| #4532 acceptance item | State after this part |
|---|---|
| CLI 全部子命令在纯 REST 下工作 | ✅ verified live (this doc, §2) |
| token / base-url wiring 落地并有文档 | ✅ part 1 (PR #4533) — flag > env > default, documented in `skills/channel/README.md` |
| PrimaryNode 未启动场景可操作错误 + 测试 | ✅ part 1 tests + live re-verification (§3) |
| README transport parity 更新 | ✅ part 1 (PR #4533) |
| live 端到端验证（5 子命令逐一过） | ✅ **this part** (§2) |
| #4521 chatId 预检去留显式裁定 | ✅ part 1 recorded the ruling (keep for `send_card`, deferred for the rest); §3 shows the current deferred behavior (`400` from the REST layer) |

Remaining on #4532 after this PR: owner sign-off on the merged result. The
issue stays open — this PR does not auto-close it.
