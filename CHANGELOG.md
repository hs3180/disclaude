# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.25] - 2026-11-09

### Added

- Declare the LLM access method with `llms.<name>.via` (`chatgpt` | `api`):
  `chatgpt` (the default when an LLM has no `api` block) uses the
  Codex-managed ChatGPT login and subscription quota with the existing
  login/reauth/weekly-quota diagnostics and is only available to the codex
  backend; the explicit `api` method binds the same codex runtime to an
  OpenAI-protocol (Responses) endpoint injected as a namespaced upstream
  `model_providers` entry whose credentials travel only through the child
  process environment. The two paths never silently fall back to one
  another — `via: api` without an `api` block, `via: chatgpt` alongside an
  `api` block, non-codex backends bound to `chatgpt`, and mixed or
  unsupported protocol combinations fail at configuration time with
  actionable errors. Entries that omit `via` keep their previous meaning
  and legacy `api`-block configurations keep resolving exactly as before;
  service startup probes now receive the resolved agent configuration and
  no longer misreport under an API-bound access method (#5338; #5724).

## [0.6.24] - 2026-11-09


### Added

- Accept multiple named Feishu apps on a single instance: channels
  declared with `type: feishu` under their own name each keep their own
  tenant token and lark-cli credentials, route chats under a stable
  `feishu:<name>:` identity, and can set a per-channel default agent
  preset (an explicit `/agent use` still wins); text, cards, button
  callbacks, private-input flows, and image uploads use the owning
  channel's credentials, and the legacy single-app section behaves
  exactly as before when no declarations exist (#5254; #5700).
- Preinstall harness backends at Docker build time: the
  `DISCLAUDE_BACKENDS` build arg accepts `all` or a comma-separated
  subset of `claude`/`pi`/`codex`/`dsh`, driving a reproducible
  build-stage installer with pinned versions — CLI backends land on
  PATH and the Pi runtime packages in the production module-resolution
  path; unknown names fail the build with an actionable error, and no
  secrets or runtime configuration enter the image layers (#5168;
  #5710).
- Add mini-swe-agent as an optional agent provider (`miniswe` backend):
  presets reference a LiteLLM-style provider-prefixed model, the `mini`
  CLI is detected with a clear unavailable error when missing, and
  Disclaude tasks map to local headless subprocess execution with
  isolated workspaces, per-run timeouts, and credentials redacted from
  chat and logs (#5006; #5711).

### Changed

- Unify busy-input receipts across harnesses: the shared service-layer
  hint is now the only receipt source, and the Codex native interjection
  confirmation carries the current task summary, elapsed time, and queue
  context instead of a fixed line; harness-side standalone receipt
  building is removed so any backend that gains interjection support
  follows the same shape (#5713; #5714).

### Fixed

- Stop injecting the self-made skills manifest into Pi sessions when
  the optional diagnostics plugin is installed: the Pi backend now
  registers Disclaude built-in skills through the shared
  native-skill-channel contract and fails fast with an actionable
  diagnostic when a skill source cannot be delivered natively, instead
  of silently splicing a fabricated manifest into the system prompt
  (#5718; #5727).

## [0.6.23] - 2026-11-09

### Fixed

- CI: pin the `datalayer-package` (Jupyter patch CLI) workflow runner to
  `ubuntu-24.04` — `ubuntu-latest` rolled to 26.04, where the
  `actions/setup-python` toolcache no longer provides Python 3.9, randomly
  failing the Node18/Py3.9 compatibility leg and cancelling the Node24 leg
  on main pushes and PRs that trigger the workflow (#5735). CI-only
  change; the packaged runtime is identical to 0.6.22.

## [0.6.22] - 2026-11-09

### Added

- Add on-demand research document comment watching: `disclaude research
  watch start|stop|status` hosts a bounded watch session over the explicit
  `research-doc-watch` registry, with per-document checkpoints, restart-safe
  deduplication, exponential backoff, and surfaced error reports; new comments
  are routed to the original Project chat's agent, and nothing is constructed
  or scheduled while no session is running (#5197; #5708).
- Report the real delivery position in channel CLI receipts: file, text, and
  card sends echo `thread reply to <root>` or `chat root` with the message
  id, the upload handler returns `messageId`/`deliveryPosition`/
  `threadId`/`rootId` end to end over the REST protocol, and a topic-group
  send without `--parent` gets an explicit warning while still sending
  (#5722; #5730).

### Changed

- Split WeChat media CDN uploads into timed phases (connect incl. TLS,
  write, response) with a 10s connect budget and a 15s stall watchdog, so
  stuck uploads abort early with phase-level diagnostics instead of waiting
  for the overall size-aware deadline; zero-byte connect failures retry once
  safely, and upload errors carry phase/duration/byte-length details without
  payload content (#5720; #5728).
- Give long turns a 30s heartbeat timer backstop (silence detection with
  duplicate-send guards) and layer delivery progress into
  send-attempt-to-platform-result accounting: WeChat attachment delivery
  reports attempt, upload result, and send result separately, and platform
  receipts that cannot be verified are marked as such instead of implying
  the user saw the message (#5719; #5729).

## [0.6.21] - 2026-11-09

### Added

- Persist each chat's `/agent use <preset>` selection across messages and
  service restarts, and add per-application agent defaults (#5476; #5702).
  Selection precedence is the current session's explicit switch, the chat's
  saved choice, the owning application's `channels.<app>.agent` default, then
  the global default. The existing command is the only switch surface: no new
  bind command or parameter is added. Choices are stored in a validated,
  owner-only, atomically written workspace document; failed saves preserve the
  current session, and switching is refused while an affected session is busy.

## [0.6.20] - 2026-11-08

### Changed

- Deduplicate the recurring test preset configuration in the config suites
  (#5679; #5721). The named-LLM bindings repeated across the
  `resolved-agents` suites (native/selected DSH bindings, non-DSH binding
  selection, Kimi tier overrides, tier env stubs) and the loader's embedded
  preset YAML are now shared builders/fixtures with a single source of
  truth, so repeated fixtures stay in sync. Behaviour assertions are
  unchanged and production code is not touched: this is a tests-only
  change with no runtime difference from 0.6.19.

## [0.6.19] - 2026-11-07

### Added

- Attach a prefilled, sanitized GitHub report link directly to error
  diagnostics (#5428; #5697). The link is generated locally (no GitHub call,
  no credentials, no network side effects) from the failure record:
  diagnostic ID, class, UTC time, version, backend/provider and a bounded
  sanitized detail summary. Markdown-capable channels get a clickable link,
  plain-text channels get a copyable URL, and link-generation failures
  degrade explicitly without ever blocking the original error. The draft
  deliberately excludes chat/session/message/user identifiers, tokens,
  message bodies and full configuration; URLs above the copyable length
  limit raise instead of being silently truncated, and parentheses are
  percent-encoded so Markdown links do not break.

### Changed

- Restructure shared model binding so one definition works across harnesses
  (#5679; #5681). `llms.<name>` now holds provider settings with an optional
  `defaultModel` that is the wire model for every backend sharing the
  binding; agents reference the provider and may use any model it serves.
  Claude-only model identity moves to `agents.<name>.claude`:
  `behavesAs`/`modelOverrides` (previously on `llms.<name>`), a new
  three-tier `models` mapping for the opus/sonnet/haiku slots (each tier
  falls back to the provider `defaultModel`, so configuring one model points
  all tiers at it), and Claude-native env such as
  `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`. `reasoningEffort` becomes a
  provider-level default that non-applying runtimes ignore instead of a
  harness gate. A binding shared by Claude and another backend that pins a
  bare Claude alias (`opus|sonnet|haiku|fable|default`) as `defaultModel`
  now fails at config load with a fix hint — Claude resolves such aliases
  internally while DSH/Pi would send the literal string to the provider —
  and legacy placements (`llms.<name>.model`, `llms.<name>.behavesAs`,
  `llms.<name>.modelOverrides`, tier env under `llms.<name>.env`) are
  rejected with migration messages. Tests assert the model ID actually
  passed to Claude and DSH providers, not just YAML parsing.

### Removed

- Remove the `/issue` command entirely; `/feedback` is the only reporting
  entry and `/issue` input now follows the standard unknown-command path
  (#5428).

## [0.6.18] - 2026-11-06

### Added

- Wait for a Notebook run inside one turn and read stdout incrementally:
  `jupyter execute` and `status` accept `--wait` and `--timeout S` (default
  600, at most 86400); the wait loop only ever queries `notebook_status` and
  never calls stop/interrupt, so it returns on
  `completed`/`failed`/`cancelled`/`rejected` and a timeout reports
  `wait:{state:"timeout",runPreserved:true}` with the still-running state
  instead of guessing or killing the kernel execution. `notebook_status`
  gains an incremental `stdout` view: a first query without `stdoutCursor`
  returns the recent tail, passing back `stdout.nextCursor` returns exactly
  the bytes after that cursor for the same run (no duplicates, no gaps,
  idempotent re-queries, `reset` when retention no longer covers the cursor,
  `skippedBytes` when a single delta exceeds the cap), and the wait loop
  carries the cursor chain across polls. The wait loop leaves the fail-closed
  `withNotebookLock` while sleeping (initial query inside, each poll in a
  brief lock, sleep outside), so a long wait no longer starves concurrent
  commands in the same Project, and the poll function is injectable for
  backward compatibility. The Jupyter skill documents the watcher contract:
  submit without `--wait`, arm at most one background
  `status --wait --timeout 86400` watcher per runId, and let the existing
  background-task notification deliver its exit exactly once — re-arm only
  after a wait timeout, never run two live watchers (#5320; #5701).

## [0.6.17] - 2026-11-06

### Added

- Deliver concrete executable next steps as `send_interactive` candidate
  cards: the channel skill now carries an "executable next-step candidates"
  contract — a single option is enough, each button's action prompt carries
  the full instruction bound to the current session/thread-root, the
  idempotency key (`next-step:<origin>`) prevents duplicate cards on retries,
  nothing runs before the click, and no card is sent for plain confirmations,
  unbeneficial follow-ups, pending review feedback, strict JSON or code-only
  output, or card-less channels; a service-level regression reproduces the
  dependency-retirement scenario through the real delivery chain (#5472;
  #5693).
- Render table-bearing final Markdown replies as Feishu Card 2.0: a final
  Claude result that contains a GFM table outside code fences and no
  `## Sources` trailer is now converted to a native card
  (`final-markdown-card.ts`, `column_set` layout) — sent once as an
  interactive card in non-streaming mode and as an in-place replacement of
  the streaming card at finalize, never a second message; raw JSON,
  code-only output and card-less payloads stay plain text, over-budget
  payloads use the existing payload budget, and explicit Feishu rejections
  degrade to text exactly once (#5487; #5695).
- Fail closed on cross-channel chat ownership collisions: when multiple
  channel types are enabled on one instance, a chat id claimed by two
  channels no longer silently rebinds — inbound delivery during the conflict
  is rejected, `forgetChannelRoutes` cleanup is unified, and an unregistered
  or recovered channel re-binds to the sole healthy owner; text, attachment
  and card handlers reject ambiguous ownership before parsing, and a
  same-process Feishu+WeChat integration regression covers inbound
  ownership, outbound text/attachment routing, capability queries, zero
  delivery on ambiguity, single-channel startup failure isolation and route
  recovery after unregister (#5449; #5698).
- Ship an offline Card 2.0 help and validation surface: `channel card_help`
  lists/searches components (card, header, markdown, column_set, column,
  collapsible_panel, hr) with field-level help and editable native examples,
  and `channel card_check --card|--card-file|-` validates chat-independent,
  offline, with no message or upload side effects; valid input exits 0 with
  `{"ok":true}` and invalid input returns stable `CARD_*` diagnostic codes
  with RFC 6901 JSON Pointers and a help entry point; the bundled
  `CARD2_SPEC` snapshot declares its source and `partial` coverage and
  unknown components answer `NOT_IN_CATALOG` instead of claiming support,
  with a short `card-2` skill and a sanitized metrics/columns/collapsible
  fixture that agents can self-correct against (#5512; #5703).

### Changed

- Stop fabricating a skills manifest into Codex exec/resume prompts: the
  exec transport has no compliant native registration channel (probed
  0.151.0 — only `<cwd>/.codex/skills` and `$CODEX_HOME/skills` are scanned,
  no flag/env/config key, plugins require prior install), so when Disclaude
  skill roots exist the exec transport now fails fast with an actionable
  app-server-transport diagnostic instead of injecting a self-made
  name/path/description list into first/multi-turn/resume inputs; the
  app-server native `skills/extraRoots/set` path is unchanged, effective
  skill sets stay identical across transports via the shared
  `codexNativeSkillRoots()` computation, and the only remaining DSH/Pi
  opt-in discovery path is the receipt-verified `diagnosticsPluginManifest`
  (#5520; #5683).
- Raise the Jupyter `import-file` ceiling from 2MB to 512MB with chunked
  upload and verified readback: files above 2MB now go through the
  jupyter-server `LargeFileManager` chunked contract (8MiB chunks,
  `chunk 1..N/-1`), the finished upload is verified by streaming SHA-256
  readback through the `files/` route before `imported` is returned, any
  failed chunk or checksum mismatch best-effort deletes the remote partial
  and returns a retryable diagnostic, and a stale same-name partial with a
  mismatched size is cleaned up and re-uploaded automatically (Disclaude
  input directories only); the small-file path keeps byte-exact existing/
  no-overwrite semantics, the 512MB ceiling is rejected locally before any
  remote write, and the request timeout for `import-file` rises to 300s
  (#5318; #5696).
- Auto-create missing remote parent directories on Notebook creation:
  `jupyter create --path a/b/c.ipynb` now walks the parent chain level by
  level (GET, and PUT `directory` only on 404), so a fresh remote succeeds
  directly instead of failing with a generic error; already-existing
  directories are idempotent, and a rejected creation keeps HTTP status,
  server body, the parent path and a permission hint in the error so the
  next step is actionable (#5314; #5687).

## [0.6.16] - 2026-11-06

### Changed

- Layer the automatic welcome message for non-technical first-time users and
  trim it to channel capabilities (#5475; #5704). A task-oriented
  `buildWelcomeMessage(channel)` template now backs both the WeChat and Feishu
  automatic welcome paths: plain text with three ready-to-send examples
  ("总结这份文件的重点" style), no Markdown residue and no backend/command/
  preset jargon, ending in a /help pointer. The explicit `/help` command keeps
  the full dynamic command view. The WeChat welcome text is evaluated at send
  time via `getWeChatWelcomeText()` instead of a module-load constant, and the
  WeChat CLI status output stays pure JSON (log-level fallback no longer
  leaks ConfigLoader info lines into `wechat status` stdout).
- Include the Notebook lifecycle commands in the Jupyter `tools` schema and
  unify their JSON input contract, documenting four existing contracts
  (#5321; #5706). `disclaude jupyter tools` now lists all 21 commands
  (adding `check`, `link`, `create`, `unlink` with `type: object` /
  `additionalProperties: false` schemas); `link`/`create`/`unlink` accept
  `--input-file` JSON (`--path` stays as an equivalent shorthand, and
  providing both or neither is rejected before any remote call). The phantom
  empty first cell of a fresh Notebook (empty-string SHA-256, reported via
  `removedSeedCellId` on first append), per-kernel FIFO execution with
  same-cell superseding, and the Project-relative single-file constraint of
  `import-file` are now stated in the schema descriptions, module README and
  the Jupyter skill instead of being discovered by trial and error.

## [0.6.15] - 2026-11-05

### Added

- Expose the Jupyter kernel host and GPU UUIDs through a `runtime-probe`
  command: an existing kernel is probed with fixed host-owned code
  (no Notebook writeback, no store_history) that returns a SHA-256 host
  id and sorted unique GPU UUIDs under a stable
  `disclaude.jupyter-runtime.v1` schema; unavailable metadata is
  reported as explicit `unknown` and never as an empty list, so agents
  can decide same-card exclusion without hand-running `nvidia-smi`
  (#5322; #5691).
- Automate the Feishu discussion-group handoff in the start-discussion
  skill: one ordered chain creates the group with `--owner
  <triggering user>`, sends and pins the positioning first post, replies
  with a migration card in the source thread, and only then injects the
  initialization context — the script stops at the first failed stage,
  is idempotent by key, and never re-runs blindly after a partial
  result (#5393; #5690).
- Lock in the unrecognized slash-command passthrough contract across
  p2p, group-mention and topic entry points: an unregistered `/xxx`
  command with arguments, multiline text, CJK content and quoting is
  forwarded verbatim exactly once, while registered-command argument
  errors, permission denials and execution failures stay out of the
  agent path (#5401; #5689).

### Changed

- Track async-question capability per turn instead of per session: a
  new `asyncUserInputCapable` probe reflecting the same conditions that
  reject async questions at runtime (once-mode, superseded session
  generation) lets the provider announce the incapability in the prompt
  up-front and reject async questions as a structured "unsupported"
  error before host wiring, instead of surfacing a host rejection
  mid-turn (#5467; #5665).
- Remove the hardcoded default model, model ban and fixed effort from
  the collaboration rules: model and effort selection now follows the
  current user instructions and deployment configuration, historical
  acceptance results stay scoped to their original verification, and
  concrete recommendations live only in the configuration example
  (#5407; #5688).
- Route human-readable report deliverables to the research-workflow
  skill: briefs, final reports, closing/experiment/analysis reports and
  feedback revisions on existing reports now trigger the methodology,
  while simple factual Q&A, code comments, commit messages, plain data
  tables and other non-report writing stay out (#5459; #5692).

### Fixed

- Stop the docker entrypoint from silently skipping lark-cli
  authentication on Node 22: the FEISHU_AUTH extraction script is now
  an IIFE without a top-level `return`, exit status is checked before
  the not-configured fallback, and real crashes keep their stderr and a
  WARNING instead of masquerading as "not configured" (#5680; #5686).

## [0.6.14] - 2026-11-05

### Added

- Lock in the WeChat dynamic multi-account invariants with a
  cross-component integration regression: two dynamically registered
  accounts run through the real registry, registration runtime, lifecycle
  manager and service wiring, asserting inbound isolation (qualified
  chat/message ids, private context tokens kept out of routing payloads),
  per-account outbound routing with reply context, on-disk state isolation
  (per-account `accounts/<id>` directory, `auth.json`, `session.json`
  cursor/dedup/reply-context), and restart recovery (accounts healthy
  again, replayed gateway messages deduplicated, no duplicate welcome,
  reply context restored). Production behavior is unchanged; the test
  guards the already-merged dynamic registration semantics (#5451; #5685).

## [0.6.13] - 2026-11-05

### Added

- Admit new codex sessions against the weekly rate-limit window instead of
  degrading mid-task: structured `RateLimitWindow` readings
  (`used_percent`, `window_minutes`, `resets_at`) from both the exec and
  app-server transports feed an admission check that blocks new sessions
  when quota-usage progress exceeds reset-time progress, while running
  sessions keep working and are never killed. Defaults to observe mode and
  is configurable per agent (#5607; #5677).

### Fixed

- Recognize codex thread writer-lock conflicts as a waitable busy state:
  the original request is preserved, a visible note explains that the
  session is occupied by another writer, and bounded jittered retries
  (2/4/8/15s, at most five attempts within a configurable budget) resume
  once the lock clears; `/stop` still cancels during the wait (#5429;
  #5682).
- Make launchd service installation atomic and idempotent: plists are
  staged to a temporary file, validated with `plutil -lint`, and renamed
  into place; service and Chromium lifecycle calls use modern
  `bootstrap`/`bootout`/`print` semantics with a resolve/reload/activate
  plan and a bounded activation lock; uninstall cleans service-owned
  state, logs and configuration with an explicit `--purge-profile` option
  for user profile data (#5619; #5664).
- Recommend non-hourly minutes and per-chat staggering in the scheduling
  skill examples so same-chat jobs stop colliding on the hour (#5606;
  #5684).
- Ship retail Google Chrome in the Chromium container image so
  `navigator.userAgentData.brands` matches the User-Agent string;
  `select_browser_binary()` fails closed when the retail binary is absent,
  with no Playwright fallback (#5652; #5658).

## [0.6.12] - 2026-11-05

### Fixed

- Enable software WebGL in the headed Chromium container through SwiftShader
  and ANGLE Vulkan, restore the previous browser session so session cookies
  survive container recreation when the profile volume is retained, and align
  the browser UI language with the first `CHROMIUM_ACCEPT_LANG` segment
  (#5653; #5657).
- Keep the Chromium profile on a declared volume and allow Compose deployments
  to select either the managed named volume or an operator-provided host
  directory through `CHROMIUM_PROFILE_VOLUME` (#5653; #5657).

## [0.6.11] - 2026-11-05

### Added

- Explain WeChat re-login identity mismatches and how to continue safely:
  a scan that lands on a new bot id now reports the old/new identity
  difference and, when the WeChat-server user id matches, points at a
  plain-login continuation path instead of a bare rejection (#5480; #5662).
- Collapse delivered notebook code cells by default through the standard
  `jupyter.source_hidden` metadata, so reports open on text and outputs
  first; markdown cells, editing and export fidelity are unchanged
  (#5615; #5663).
- Keep long narration-silent turns observable: a platform heartbeat
  reports lightweight progress once a turn has been silent for five
  minutes despite real tool activity, and a failed turn ends with a receipt
  of the tools it already ran (name and count only), so completed side
  effects are no longer lost (#5654; #5671).
- Bridge the claude backend's AskUserQuestion tool to the host input
  channel, reusing the persisted task-question admission flow so claude
  sessions can ask structured questions through channel cards (#5613;
  #5676).

### Fixed

- Stop masking terminal notifications of background subagents behind the
  task-snapshot path: a spawned background agent that finishes after
  end_turn now delivers its completion, instead of leaving the session
  fake-busy forever (#5330; #5631).
- Remove the RTC-seeded empty first cell when a notebook append creates
  the first user cell, so delivered notebooks no longer open on a blank
  cell (#5548; #5633).
- Validate the cached CDP WebSocket identity against the live
  `/json/version` before each attach and re-discover on drift, so a
  browser restart self-heals instead of leaving every call on persistent
  404s (#5427; #5660).
- Route busy-time supplemental receipts to the topic the running turn's
  replies live in, so one task no longer splits between the thread and the
  main chat (#5435; #5667).
- Preserve structured forensics for channel HTTP failures: method, URL,
  status, allowlisted headers and a truncated sanitized body are logged,
  and Feishu business error codes/messages reach the error string and
  notifications (#5655; #5670).
- Upload WeChat media over a `node:https` channel with a size-derived
  deadline, fixing intermittent CDN upload failures for ~15MB videos
  (#5516; #5672).
- Suppress duplicate question turns for attachments already consumed by a
  running request, including the channel-FIFO queue path (#5434; #5674).

### Changed

- Name and document the WeChat typing refresh cadence constants together
  with their trade-offs (#5471; #5647).
- De-flake the goal-execution-service status-transition test by waiting
  for the persisted terminal condition instead of a fixed timer drain
  (#5675).

## [0.6.10] - 2026-11-04

### Fixed

- Make input consumption visible while a turn is busy: picking up a queued
  input now emits a receipt anchored to that input, and admission receipts
  name the attachments carried along, so a user can tell their input was
  consumed instead of re-asking during long waits (#5470; #5666).
- Send scheduler informational notices best-effort: a transient failure of
  the scheduled-task opening notice (or other purely informational notices)
  no longer aborts the task or counts toward its consecutive failures — the
  task still routes and runs; task-body failure accounting is unchanged
  (#5656; #5669).
- Record host-side rejections of blocking async questions in
  push-initialized sessions as the structured local input-delivery failure
  with the natively completed turn state preserved and exactly one notice,
  instead of an unlabelled protocol cancellation that mislabels a delivered
  turn as provider-failed (#5430; #5668).

### Changed

- De-flake the #5514 capacity-budget regression test (#5648) and make the
  browser-control CLI 404-provenance test deterministic (#5673), so main
  Unit Tests are green again on consecutive batches.

## [0.6.9] - 2026-11-04

### Fixed

- Do not declare a live browser runtime owner dead just because
  `service.lock` was re-created at the same path: ownership proof matches the
  lock inode recorded in the runtime manifest and falls back to PID/lstart
  liveness checks on drift, `--reload` atomically heals the manifest evidence
  (emitting `browser-owner-evidence-refreshed`) instead of aborting with
  "owner is not live", and the takeover gate no longer preempts a live owner
  while still allowing recovery from a truly dead one, including PID reuse
  (#5474; #5661).
- Attach stage-matched recovery guidance to browser HTTP 404 failures:
  `http-discovery`, `websocket-attach` and `page-navigation` each carry their
  own remedy through the existing browserDiagnostic record, so an agent can
  map a 404 to the right recovery action instead of restarting blindly
  (#5352; #5659).

## [0.6.8] - 2026-11-04

### Added

- Provide a session history query service as the primary agent entry:
  `disclaude history query` and the REST `GET /api/history/query` route, with
  agent-facing documentation (#5603, #5618; #5611, #5629).
- Add a verifiable launchd service lifecycle: `generatePlist()` derives a
  production-faithful plist from `.disclaude` configuration, and the new
  `disclaude service install|start|stop|restart|status|logs|uninstall|generate`
  commands manage it, all with `--dry-run` support (#5619; #5628).
- Land the goal/board/coordination suite: the single-entry `/goal` command
  surface with native execution (#5559, #5563, #5592), private versioned goal
  persistence and a sequential continuation driver (#5538, #5539), explicit
  lifecycle controls, draft records and revision-bound turn assessments
  (#5542, #5543, #5556, #5557), durable versioned task claims with
  projection-checked admission (#5553, #5579, #5596, #5597), durable task
  submission and review records read and patched through lark-cli
  (#5621, #5622), receipt inboxes for task work and review proposals
  (#5623, #5624), background task ownership wired into the default service
  with native-only child reporting (#5574, #5620), independently scoped task
  executions (#5550), Feishu task feedback cards and question callbacks
  (#5589, #5590), persisted question/answer delivery state (#5585, #5586),
  input admission receipts and chat-scoped query hooks (#5587, #5588), host
  tools bound to the originating input context with host-verified user-input
  provenance (#5554, #5555), host query hooks forwarded through factory
  creation (#5558), temporary sessions retained until native work settles
  (#5547), and review-side Project artifact identity verification (#5581).
- Bind WeChat conversation identity to stable peer identifiers (persisted
  atomically, scoped to the operator identity) so a re-registration continues
  the original chatId instead of forking the session (#5600; #5634).

### Changed

- Route busy-session input by thread ownership before steering: a new task
  sent to the main conversation gets its own execution and delivery boundary,
  while same-topic follow-ups still steer the running turn (#5464; #5638).

### Fixed

- Quarantine corrupt WeChat registry locks (for example the zero-byte lock
  left behind by ENOSPC) and rebuild the lock automatically, so a host no
  longer crash-loops with a permanently degraded registry; carries the
  earlier startup isolation, atomic lock publication and manual
  lock-recovery groundwork (#5513; #5525, #5523, #5577, #5632).
- Surface underlying cause codes for WeChat CDN upload failures with
  structured, sanitized diagnostics (#5516; #5536, #5625), keep inbound
  image failures recoverable through a durable asynchronous media inbox
  (#5518; #5530, #5532, #5636), and give channel-cli JSON output structured
  delivery diagnostics with two-layer diagnostic ids (#5616; #5639).
- Give the Feishu upload-file chain a chain-aware deadline with per-stage
  timings and idempotency keys, so a slow upload no longer collapses into an
  ambiguous 30-second REST timeout (#5630; #5644).
- Resume the waiting session automatically after a private input card is
  consumed, with a distinguishable safe failure path instead of a false
  failure report (#5411; #5626).
- Keep delivered outcomes when an async question card fails: the native
  completion stands, the failure is reported once with bounded diagnostics,
  and the `/api/push` initialization scenario is covered (#5526, #5430;
  #5528, #5535, #5635).
- Recover a tripped delivery circuit through a bounded half-open probe with
  backfill of skipped replies, exposing `deliveryCircuitStatus()`
  (#5470; #5531, #5637).
- Wait for DNS resolution and a real websocket connection before reporting a
  Feishu channel as available at startup, and expose Feishu ingress readiness
  independently in health checks (#5519; #5533, #5534, #5643).
- Preserve forwarded card content in Feishu thread context (schema 2.0 card
  bodies and merge-forwarded messages) instead of degrading to a placeholder
  (#5433; #5645).
- Exclude healthy work from the codex capacity recovery budget with
  regression coverage, so long-running tasks no longer exhaust the recovery
  window (#5514; #5524, #5641), reject capacity waits for dependent queries
  (#5567; #5568), persist task results before parent notification (#5571),
  and refuse reconnects after native owner disposal so independent tasks can
  settle (#5572; #5573).
- Configure native foreground Bash timeouts by default for SDK subprocesses
  so babysit-style waiting commands can no longer wedge a session forever
  (#5515; #5541).
- Surface the CDP endpoint and runtime failure causes in
  `disclaude browser status` with classified remedies, including stale or
  invalid runtime.json states (#5601; #5642).
- Welcome new WeChat peers once after valid reply context, with login
  onboarding guidance toward the first message (#5469; #5545, #5646), and
  retain the typing indicator through task and delivery settlement
  (#5471; #5544).
- Diagnose system heartbeats without assuming rate limits (#5537), load codex
  skills in place through native directory roots (#5546), resolve leftover
  goal.md merge markers (#5591; #5627), and finish the single-entry surface
  left behind by #5559, repairing main Unit Tests (#5617).
- Rebuild the runtime before generating the Git distribution: prune stale
  build artifacts, force `tsc --build`, assert the source tree did not
  change, and record build provenance in `release-source.json` — the 0.6.7
  archive shipped stale dist output for files already fixed on its declared
  source (#5517; #5522), and the install acceptance test now isolates
  inherited workspace context (#5527).

## [0.6.7] - 2026-10-23

### Added

- Classify codex `max_output_tokens` turn failures with a progress-aware
  receipt that reports what completed before the interruption (#5452, #5492).
- Continue the same codex thread after a capacity failure once real progress
  exists, instead of dropping the turn (#5468, #5494).

### Changed

- Degrade unsupported codex async questions to plain text instead of dumping
  tool-surface usage instructions into the chat (#5467, #5493).
- Adapt GFM tables in Feishu auto citation cards through a converter local
  to the card builders (#5473, #5485, #5486).
- Assert the Node.js security baseline (2026-10-21 release train) at service
  image build time (#5481, #5484) and bump the Chromium base image default
  to `v1.64.1-noble`, the first-party distribution line (#5482, #5483).
- Pre-link the canonical config slot in the service image so official mounts
  no longer trip the legacy-location warning (#5431, #5490), and parse
  `channels.feishu` credentials with the loader's own primitives
  (#5432, #5491).

### Fixed

- Harden the WeChat re-login path end to end: probe the old login before
  reporting a rolled-back re-login (#5500), require remote poll confirmation
  before listener health is declared (#5501), and report login stages while
  verifying fresh credentials before declaring registration (#5502, carrying
  the relogin-isolation regressions, installed-package rollback lifecycle,
  and SIGTERM fix from #5503).
- Keep `disclaude start` responsive to SIGTERM even when a held long poll
  swallows both its listener abort and its own deadline (#5502).
- Keep safe rejection detail on WeChat API errors — endpoint path, HTTP
  status, and a diagnostic id — instead of a bare numeric code (#5478,
  #5497), and retry the listener lock when its owner releases it
  mid-acquisition (#5499).
- Keep message-topic identity for Feishu p2p and group inputs so a new task
  in the main conversation no longer threads into an old topic (#5464,
  #5488).
- Re-discover CDP after browser `--reload` while migrating the runtime
  identity (#5427, #5496), and validate replaced `service.lock` ownership
  by inode (#5474, #5495).
- Explain a scanned identity change during a forced WeChat re-login instead
  of failing without guidance for safely adopting the new bot identity
  (#5480, #5507).
- Keep used Feishu private-input cards on their real terminal status so a
  successful submission no longer shows as expired (#5489, #5508).
- Carry the real failure through a codex `turn/start` ACK timeout: the
  structured timeout reaches settlement exactly once with its method, stage
  and submission uncertainty, restart classification uses the real error,
  and the timed-out request is never replayed (#5505, #5509).
- Drop self-sent user-identity echoes before they re-enter the conversation:
  a bounded self-sent registry, a `self_sent` filter reason ahead of the
  dedup claim, and a Bearer-authenticated `POST /api/self-sent/:messageId`
  registration route for session-side senders (#5504, #5510).

### Verification and scope

- Runtime source main `f28bc219` passed all seven returned CI checks.
  Real-machine coverage this round: QR hot registration on an isolated
  instance built from main, inbound message to agent auto-reply, and
  channel `send_text` proactive smoke; the relogin lifecycle is covered by
  the local WeChat (164/164) and integration (9/9) suites in #5502.
- Four late-filed bugs (#5480, #5489, #5504, #5505) were added to the
  release scope after review; each fix landed through its own PR with all
  CI checks green on main `dcd19b29`.
- The final archive, provenance, checksums, and fresh installation results
  are recorded in the release assets. Upgrading an existing deployed
  service remains a separate operation. The package is distributed through
  a prebuilt GitHub tag, not the npm registry.
- See the [0.6.7 release notes](docs/releases/0.6.7.md).

## [0.6.6] - 2026-10-21

### Added

- Personal WeChat through Tencent iLink: headless QR login, read-only login
  status, saved credentials, per-peer reply contexts, and encrypted image/file
  transfer through the common Agent attachment interface (#4889, #5436–#5448).
- Native MP4 delivery and existing public progress/decision summaries before
  final replies, through the same channel CLI and Agent callbacks (#5450,
  #5453, #5455).
- A private dynamic account registry with zero-account startup, hot registration,
  stable account-scoped routing, and login/status/enable/disable/remove commands
  without a configured account list (#5451, #5457, #5458, #5460–#5462).

### Changed

- Run Feishu, REST, and registered WeChat channels in one service process;
  retain healthy channels when another fails to start and reject unknown or
  ambiguous reply targets instead of falling back to a different owner (#5449).
- Keep managed channel commands on the current installation's complete CLI
  path, send diagnostics to stderr, and avoid host file-log writes from CLI
  commands (#5448).
- Make Docker service and Chromium container workflows manual-only; retain
  regular build, unit, lint/type, installation, and workspace CI (#5456).

### Fixed

- Read current iLink polling/message IDs, retry failed inbound handoffs, and
  checkpoint accepted message IDs, cursors, and reply contexts (#5436, #5437).
- Bound Unicode text parts and encrypted media/cache sizes, preserve server
  message IDs, and report partial or unknown sends without blindly resending
  successful or ambiguous operations (#5442, #5446, #5447).

### Verification and scope

- Runtime source main `d7ed69eee` passed all seven returned CI checks. Real
  single-account acceptance covers QR hot registration, text, incoming image,
  TXT file round trip including phone content confirmation, MP4 picture/sound,
  public progress/final messages, disable/enable, normal restart, and C3
  same-process Feishu/WeChat replies with restoration of the original service.
- Real dual-account isolation and additional fault/edge scenarios were not
  requested for this release; their absence is not recorded as a pass.
- The final archive, provenance, checksums, and package installation checks are
  recorded in release assets. Deployment of an existing daily service remains
  a separate operation. The package is distributed through a prebuilt GitHub
  tag, not the npm registry.
- See the [0.6.6 release notes](docs/releases/0.6.6.md).

## [0.6.5] - 2026-10-17

### Added

- Report problems to GitHub from a chat: `/issue` presents a sanitized
  confirmation card with the per-chat last failure, then files an issue
  through a restricted GitHub App client with diagnostic-id deduplication
  and an explicit "not submitted" failure path that never claims success
  (#5400, #5424, #5425).
- Declare gateway model identity with first-class `modelOverrides`,
  projecting an explicit context window and capability flags per advertised
  model (#5410, #5421).

### Changed

- Fold oversized mid-turn narration payloads into one-line summaries with
  opt-in expansion, completing the reversal of the closed #5397 decision
  (#5395, #5418).
- Carry the running turn summary, elapsed time and queue depth in busy
  notices instead of fixed texts (#5394, #5417).

### Fixed

- Bound busy-input admission before turn accounting so queue pressure
  cannot exhaust the anchor budget (#5399, #5416).
- Keep a successful Codex answer delivery across serverRequest/resolved
  ordering at completion (#5404, #5415).
- Retry transient Codex 429 rate limits with bounded backoff, separating
  temporary throttling from exhausted quotas (#5408, #5414).
- Keep video delivery on the media path without ffmpeg, and stop reporting
  Feishu media rejections as an unreachable service (#5391, #5413).
- Classify connectivity-class provider failures separately with an egress
  hint instead of a generic provider error (#5409, #5419).

### Verification and scope

- Main `50fe57ce` passed the six-check CI suite (build, lint and type
  check, unit tests, package-installation acceptance, service-image
  lifecycle and workspace onboarding) after both #5400 pull requests
  merged. Their local suites, including the new GitHub-client and
  card-callback tests, were green.
- No new real-model acceptance window was run for 0.6.5; the `/issue` flow
  is covered by unit tests with faked Feishu and GitHub clients.
- #5402 remains scheduled for 0.7.0 by maintainer decision. npm
  publication stays outside the Git release flow: `publish.yml` is
  manual-only and has never been run.
- See the [0.6.5 release notes](docs/releases/0.6.5.md) for installation
  and configuration boundaries.

## [0.6.4] - 2026-10-17

### Changed

- Let the Claude SDK own retries and usage reporting; remove the host retry
  budget and per-attempt audit layer (#5382, #5383).
- Preserve ordinary busy-input streaming and let running tools finish; use
  explicit `/stop` for interruption. Queue-pressure hardening is tracked
  separately in #5399 (#5258; #5388 was closed without merging).
- Use named agents and LLM bindings with an explicit model and external secret
  files. Project only the selected binding into each harness and mask explicit
  secret-file sources. Legacy configuration is not accepted unchanged and no
  compatibility or automatic migration layer is provided (#5233, #5387).
- Make diagnostics an optional project-local CLI-installed plugin, with native
  discovery by Claude, Codex, DSH and Pi (#5251, #5385).
- Reuse dependency download caches while keeping installation trees independent;
  retain opt-in cleanup and the existing read-only retention report (#5384).

### Fixed

- Distinguish browser discovery, WebSocket attach and navigation failures, with
  bounded safely redacted error-response summaries (#5386). The original #5352
  incident remains unexplained and is outside this release milestone.
- Finish a parent input once when a native background Agent later delivers a
  child result; preserve the child reply and callbacks. Attribute streamed and
  fallback delivery to its owning turn and record actual P2P visibility (#5390).
- Deliver necessary public decision narration before tool calls in group/topic
  conversations and streamed replies, while keeping raw thinking, tool payloads
  and child-agent frames private (#5377, #5381).

### Verification and scope

- Main `193d83d82` passed build/lint, 5,845 tests in 279 files, independent
  prebuilt installation and nine actual model inputs. The real-channel window
  used the authorized self-test chats, accepted as the final #5258 scope; the
  original daily service was restored. These are source-specific receipts,
  not a claim of new model acceptance on a later packaging-only commit.
- Native model `isSecret` support (#5403), the controlled input-settlement
  ordering case (#5404), native session resume (#5405), and queue-pressure
  protection (#5399) remain future work. The candidate-prefix discovery gap
  (#5354) was explicitly dropped, not fixed or relabelled as passed.
- See the [0.6.4 release notes](docs/releases/0.6.4.md) for installation,
  configuration and verification boundaries. The
  [RC delivery record](docs/releases/0.6.4-rc.1.md) is a dated historical
  snapshot; its old review state and candidate outcomes remain at their
  original sources.

## [0.6.2] - 2026-09-30

### Added

- Add read-only Chromium CDP `status` and `doctor` diagnostics for the selected
  executable, Profile, managed service, and CDP listener (#4828, partial).
- Allow Codex model and reasoning effort to be configured together, with the
  effective value and source reported for diagnosis (#5136, #5137).

### Changed

- Suggest one concrete, optional next step using the user's goal, conversation,
  constraints, prior choices, findings, and artifacts (#5189).
- Clarify when a scheduled task uses a direct command versus an agent prompt,
  including each mode's fields and timeout behavior (#4929).
- Document how Research guidance can notify relevant whole-document commenters
  after a substantive edit and successful read-back (#5179).

### Fixed

- Let the Claude SDK own stream retries while retaining result-level failure
  handling and completed-empty-stream behavior (#5205).
- Report invalid schedule configuration in the task's configured chat, suppress
  duplicate alerts, and allow a changed owner to receive a relevant warning
  (#5201).

### Boundaries

- The Research notification guidance and schedule-owner alerts still need
  real Feishu/Project acceptance. Chromium diagnostics are a read-only slice and
  do not complete interactive installation or Profile migration. Codex citation
  source mapping is not included because the current app-server protocol does
  not expose verifiable answer-to-source metadata.

## [0.6.1] - 2026-09-29

### Changed

- Serialize each complete upstream `browser-use` CLI invocation per CDP browser;
  remove the broker IPC/coordinator and managed Python runtime (#5185, #5188).
- Include README and CHANGELOG in generated release packages (#5191).

### Fixed

- Return actionable diagnostics when Codex turn controls are requested without a
  confirmed active turn (#5186).
- Preserve Feishu thread context for follow-up cards, including Codex follow-up
  actions and retry deduplication (#5190, #5192, #5195).
- Preserve attachment-only input and queued-request correlation; finish Codex LRU
  eviction without a misleading reconnect notice or automatic restart
  (#5181, #5015, #5196).
- Parse schedule YAML frontmatter correctly so inline comments do not corrupt
  cron expressions and silently stop scheduled tasks (#5201).
- Use the configured persistent Chromium profile path for launchd and Docker;
  remove offline profile-copy setup and migration paths (#5202).

### Maintenance

- Clear development-tooling npm audit findings without changing runtime
  dependencies (#5183).
- Remove real-Chrome access checks from required CI while keeping service
  lifecycle and persisted-data acceptance (#5198).

### Documentation

- Consolidate the README and current user/operator guides, remove superseded
  history, and align browser guidance with the shipped CLI-lock design (#5187).

## [0.6.0] - 2026-09-24

### Added

- Agentic Research in existing Feishu Projects: investigate from ordinary project conversations, deliver readable research documents, keep detailed source records in the Project, and continue through comments, chat feedback, or structured follow-up.
- Evidence-led report generation and revision that distinguish observations from interpretations, connect important judgments to sources, and make alternative explanations and conclusion boundaries readable.
- Codex `requestUserInput` cards in Feishu that preserve question/answer identity and return submitted answers to the original turn.
- Coordinated browser control and assisted Chromium setup, with shared ownership/handoff, lifecycle recovery, persistent profiles, and clearer service diagnostics on supported environments.

### Changed

- Keep Research within the existing Project, workspace, and agent harness; do not require a separate Research project type, runtime, task database, fixed workflow, or control panel.
- Use generated GitHub distribution tags for installation. The source package remains private and is not published to the npm registry.

### Fixed

- Improve Codex execution outcome reporting, asynchronous user-input handling, project working-directory consistency, browser process cleanup, and package-install test isolation.
- Refresh compatible runtime dependencies, including the Feishu SDK, HTTP client, YAML parser, and protobuf runtime.

### Boundaries

- Browser lifecycle and collaboration support does not guarantee access to every authenticated, challenged, or anti-bot-protected website.
- Research follow-up works through ordinary chat and non-sensitive structured input; this release does not promise that every model can generate native secret (`isSecret`) questions.
- Final package provenance and installation results are recorded against the tested distribution; this changelog entry alone is not proof that a tag has been published.

## [0.5.3] - 2026-09-13

### Added

- Shared SkillsRegistry with deterministic precedence, trust checks, diagnostics, and one resolved Codex exec/app-server manifest.

### Fixed

- Keep project skill discovery separate from transient chat workspaces; reject unsafe resource names and refresh cached rejection diagnostics.
- Terminate persistent runtime errors without misleading reconnect/backoff behavior.
- Pass the current managed API address and authentication context to scheduled commands.
- Attach completion feedback to the actual delivered reply, including finalized streaming cards and fallback messages. Failed, cancelled, and receipt-less turns do not receive a completion reaction.

### Changed

- Remove standalone `✅ Complete` summaries. Reaction failures are bounded and do not create extra fallback messages.
- Finalize streaming replies at each turn boundary and release stream state even when the last content update fails.

See the [published 0.5.3 release](https://github.com/hs3180/disclaude/releases/tag/v0.5.3).

## [0.5.2] - 2026-09-12

### Added

- Agent-defined private input workflows through `disclaude channel request_private_input`, with one-use identity-bound delivery and fixed public outcomes.
- Prompt-based external skill authoring guidance, including GitHub App creation and authentication in one external skill.

### Fixed

- Owned Codex process cleanup and resource diagnostics, bounded UNKNOWN recovery without input replay, and queued input-to-delivery correlation.
- Internal tool/status visibility, explicit backend failure behavior and non-native compaction boundaries.
- Generated distribution fingerprints now include nested runtime sources.

### Changed

- Move bundled GitHub authentication and automation skills out of the distribution; existing user workspaces and schedules require explicit migration.
- Keep credential lifecycle with agents and remove global security-output filtering.
- Replace committed Git candidate fixtures with CI installation checks built from the current checkout.

See the [published 0.5.2 release](https://github.com/hs3180/disclaude/releases/tag/v0.5.2), including its same-version session-eviction update.

## [0.5.1] - 2026-09-11

### Fixed

- Honor YAML-only Anthropic/GLM credentials during Claude backend startup; fail clearly instead of silently switching backends.
- Accept future suffixed Codex model IDs and prefer user-level configuration files.
- Resolve unmarked agent presets in declaration order; reject ambiguous numeric names and report empty maps without a TypeError.
- Remove retired task/dialogue trackers and prune obsolete generated files before building and packaging.
- Isolate unit tests from local developer configuration and clarify channel CLI parent-reply guidance.

### Changed

- Replace the fixed non-Claude compaction threshold with explicit configuration first, then provider model-context discovery at 80% of the reported limit. Missing metadata warns without injecting a guessed threshold; `0` disables automatic compaction.

### Documentation

- Publish the prebuilt GitHub `v0.5.1` distribution tag for global installation; the root package remains private to npm.

### Known limitations

- DeepSeek's model API currently omits context limits: set `agent.autoCompactWindow` explicitly. Oversized single inputs can still fail before later compaction/recovery.
- Live 0.5.1 delivery acceptance covers text, files, and text parent replies in the designated regular group, not every private/topic/card scenario.

## [0.5.0] - 2026-09-10

### Highlights

0.5.0 delivers unified backend selection, runtime control, and reliable scheduled
work across Claude, Codex, pi, and DeepSeek integrations.

### Added

- Named backend/model presets with legacy configuration support and chat-scoped selection. Failed or busy-session switches preserve the current selection.
- DeepSeek harness execution through dsh 0.1.2, including native tools, multi-turn input, cancellation and Feishu final delivery.
- Optional pi 0.83 execution with native Bash/Read/Write/Edit tools and an Anthropic-compatible provider endpoint.
- Codex app-server steering with backend acknowledgement, cancellation completion and same-thread follow-up.
- Script schedules that poll without model calls and explicitly push changed work to an agent.

### Changed

- Settle turns by message identity and bound schedule/history state.
- Propagate OS-assigned internal API addresses to managed clients; keep project cwd and instance state isolated.
- Unify the channel CLI under `disclaude channel`, including REST destinations and the real `disclaude start` entry point.
- Use Claude Agent SDK 0.3.263; share watchdog parameter parsing, scope Claude-specific injections and keep listener cleanup owned by each query.
- Separate stable prompt guidance from per-turn content. This is a structural change, not a measured cache-hit claim.
- Exclude private local acceptance evidence from distributable test files.

### Fixed

- Report explicit stop as cancellation, settle waiting requests and allow the next message without a spurious circuit-breaker pause.
- Complete streaming cards and deliver observable terminal outcomes after failures, cancellation or tool-only responses.
- Preserve DeepSeek message boundaries and avoid exposing reasoning deltas as separate replies.
- Reject unsupported REST chat attachments with HTTP 400 instead of silently dropping them.
- Preserve bounded log rotation and stdout mirroring; remove obsolete PM2 deployment guidance.

### Verification and boundaries

- Runtime validation: 217 test files / 4,638 tests pass, complete integration runner passes, and four real backend suites pass 19 checks. These figures describe the 0.5.0 release-time candidate and are not current 0.6.0 acceptance evidence.
- Claude and pi were tested through the user-selected DeepSeek Anthropic-compatible provider. DeepSeek native was tested through dsh; Codex used authenticated app-server access. This does not claim every provider/model combination is supported.
- pi is an optional install with its own Node requirement. DeepSeek cancellation starts a fresh native query; cross-backend native history migration is not promised.
- Real Feishu text/file delivery, CardKit finalization, two-instance isolation, schedule wake-up and isolated launchd install/upgrade/rollback have evidence. CardKit sampling does not measure tenant-wide saturation or live 429 recovery.
- The root package stays private; distribution is through GitHub. Docker rehearsal is explicitly non-blocking. Research and the other P1 release-plan items are not promised in this delivery.

### Completed Milestones

- **Architecture Refactoring** - Per-process code separation completed (#1037)
- **Expert Declaration System** - Human expert skills declaration and credit system (#534)

## [0.3.3] - 2026-03-08

### Highlights

**Monorepo Architecture** - Major restructuring into packages directory for better modularity and code organization.

### Added

- **SubagentManager** - Unified subagent spawning for background skill execution (#1121)
- **SkillAgentManager** - Background skill execution support (#975)
- **TaskComplexityAgent** - Complex task detection and routing (#974)
- **ask_user Tool** - Human-in-the-Loop interactions with predefined options (#1012)
- **Study Guide Generator** - NotebookLM-style study materials (summary, Q&A, flashcards, quiz) (#984)
- **bbs-topic-initiator Skill** - AI BBS topic generation for community engagement (#976)
- **feedback Skill** - Quick issue submission via /feedback command (#983)
- **Ruliu Platform** - Command handling support (/reset, /status, /help) (#973, #1099)
- **Review Card Builder** - Imperial theme review cards (#965)
- **LarkClientService** - Unified Lark SDK management with IPC/WS routing (#1045, #1048, #1049, #1056, #1081, #1082)
- **REST Channel** - File transfer and configuration support (#1047)
- **Quoted Reply** - Support reading quoted reply and packed chat history (#1108)

### Changed

- **Monorepo Structure** - Created packages directory for better organization (#1046)
- **Messaging Tools** - Decoupled from Feishu-specific naming, unified MCP tool (#988)
- **IPC Architecture** - Dynamic Feishu API handlers registration, graceful fallback (#1080, #1118, #1122)
- **Removed wait_for_interaction** - No longer used, replaced by ask_user (#1096)

### Fixed

- **Card Actions** - TypeScript errors and event parsing for Feishu card interactions (#1133)
- **IPC Error Handling** - Detailed error information (#1113)
- **TypeScript/ESLint** - Multiple type and lint error fixes (#1061, #1062, #1084, #1097, #1101, #1107)
- **Tests** - Mock HTTP server, timeout adjustments for CI (#1029, #981, #982)
- **WebSocket** - Fallback for Worker Node callbacks, reconnection watchdog (#967, #969)
- **Pilot** - Output format guidance to prevent raw JSON (#970)
- **next-step Skill** - Removed obsolete update_card from allowed-tools (#1077)

### Documentation

- **Ruliu Platform** - Complete documentation (#1112)
- **BMAD-METHOD** - Integration research report (#977)

## [0.3.2] - 2026-03-02

### Added

- **ChatOps Utility** - Group chat management via commands (#423)
- **Skill Discovery** - Simple skill discovery for Agent SDK (#434)
- **MCP Tools** - `update_card` and `wait_for_interaction` for interactive cards (#350)
- **Integration Test Framework** - Complete test environment with use cases (#337, #361, #378, #384)

### Changed

- **Agent Architecture** - Unified Agent type interfaces (#301, #334, #335, #336, #339, #345, #349, #353)
- **Schedule Simplification** - Removed TypeScript Agent class, using generic Skill agent (#429)
- **Reporter Removed** - Replaced with message level system (#422)
- **PrimaryNode Split** - Refactored into focused services (#437)
- **ReflectionController** - Replaced DialogueOrchestrator (#407)
- **SDK Options** - Reverted to original format (#308)

### Fixed

- **Config Validation** - Validate based on config file provider, not env vars (#396)
- **Pilot Tool** - Disabled EnterPlanMode for Pilot agent (#405)
- **Control Commands** - Always handled locally regardless of @mentions (#400)
- **Docker** - Cleanup obsolete files, align CMD with docker-compose (#419, #420, #424)
- **Tests** - Port conflict, TypeScript/ESLint errors, coverage (#371-383, #397, #398, #410, #416)
- **Schedule** - Keep schedule.md read-only during periodic task execution (#346)
- **Dependencies** - Security vulnerability fixes (#320)

## [0.3.1] - 2026-02-28

### Changed

- **Channel Architecture Refactoring** - Decoupled platform-specific implementations from core channel logic (#163)
- **Unified File Transfer System** - Consolidated file transfer architecture, removed redundant modules (#194, #235, #267)
- **Dead Code Cleanup** - Removed unused code, incorrect exports, and duplicate implementations (#260)

### Added

- **Test Coverage Improvements** - Added unit tests for missing modules (#262, #290)

## [0.3.0] - 2026-02-27

### Highlights

**Bootstrap Development Achieved** - The project can now automatically track, analyze, and develop issues with minimal human intervention through the skill system.

### Added

- **Bootstrap Development Support** - Skills for effective GitHub CLI usage to analyze tasks and submit results (#36)
- **AgentFactory** - Unified agent creation pattern for consistent agent instantiation (#129, #131, #134)
- **PlatformAdapter Pattern** - Multi-platform support foundation (#167, #186)
- **Node-to-Node File Transfer** - Support for transferring files between execution and communication nodes (#94)
- **SDK Debug Logging** - Configurable `sdkDebug` option for SDK debug output (#183)
- **Task File Watcher** - Simplified task execution using file system watcher instead of MCP trigger (#128, #130)
- **Schedule Skill Enhancements** - CRUD operations for scheduled tasks (#144)

### Changed

- **Architecture Refactoring Phase 1-4** - Major codebase restructuring for better modularity
  - Phase 1: BaseChannel abstraction (#173)
  - Phase 2: Feishu module decoupling with Adapter interfaces (#175)
  - Phase 3: Core component extraction from feishu module (#166, #176)
  - Phase 4: PlatformAdapter pattern implementation (#186)
- **Simplified Scheduler** - Removed MCP dependency, uses Skills directly (#123, #126)
- **Simplified Error Handling** - Streamlined error handling system (#138, #140)
- **ThreadId Processing** - Simplified to use message_id directly (#169, #172)
- **Pilot State System** - Removed redundant fields, uses SDK streamInput (#161, #170, #174)
- **Task Skill Renamed** - Renamed to "deep-task" for clarity (#216)

### Fixed

- **Thread Reply Issues** - Bot messages now properly form threads using reply() method (#158, #177, #182, #192)
- **Context Preservation** - Conversation context preserved across multiple turns (#120, #185)
- **Schedule Task Execution** - Fixed infinite recursion and channel issues (#102, #109)
- **WebSocket Race Condition** - Fixed connection conflicts causing node disconnections (#41, #81, #180)
- **Pino-Vitest Compatibility** - Fixed timeout and compatibility issues (#115)
- **Docker Build Performance** - Optimized using COPY --chown (#116)
- **Static Analysis Issues** - Resolved TypeScript and ESLint warnings (#156)
- **Task/Schedule Skill Disambiguation** - Clearer trigger patterns (#191, #214)

### Removed

- **MCP-based Task Trigger** - Replaced with file watcher approach (#128, #130)
- **MCP-based Schedule Tools** - Simplified to use basic tools directly (#123, #126)
- **Skill Loader** - No longer needed for skill loading (#190)
- **Transport Abstraction** - Removed unused abstraction layer (#136)
- **ExecutionNode** - Functionality moved to other components (#136)
- **CLI Mode** - No longer needed (#215)
- **Redundant Methods** - Removed clearQueue and resetAll (#189, #196)

### Developer Experience

- **Better Test Coverage** - Improved unit tests with reduced timeout issues (#162)
- **Code Cleanup** - Removed redundant types and low-value tests (#133)
- **Documentation** - Added contributing guidelines (#97)

## [0.2.4] - 2026-02-23

### Fixed

- Fixed scheduled task execution in execution node (#114)
- Fixed thread reply functionality

## [0.2.3] - 2026-02-22

### Added

- Basic task execution system
- Schedule management via MCP tools
- Feishu channel support

## [0.2.0] - 2026-02-20

### Added


- Initial multi-agent architecture
- Pilot, Executor, Evaluator, Reporter agents
- Task flow ortestration

## [0.1.0] - 2026-02-15

### Added


- Initial release
- Basic Feishu bot functionality
- CLI interface
