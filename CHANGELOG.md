# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- Runtime validation: 217 test files / 4,638 tests pass, complete integration runner passes, and four real backend suites pass 19 checks. The [candidate record](docs/releases/0.5.0/release-candidate.md) records exact revisions, commands, artifact boundaries and remaining review status.
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
