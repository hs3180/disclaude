# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
