# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] - 2026-03-02

### Added

- **ChatOps Utility** - Group chat management via commands (#423)
- **Skill Discovery** - Simple skill discovery for Agent SDK (#434)
- **MCP Tools** - `update_card` and `wait_for_interaction` for interactive cards (#350)
- **Integration Test Framework** - Complete test environment with use cases (#337, #361, #378, #384)

### Changed

- **Agent Architecture** - Unified Agent type interfaces (#301, #334, #335, #336, #339, #345, #349, #353)
- **Schedule Simplification** - Removed TypeScript Agent class, using generic Skill Agent (#429)
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
- Task flow orchestration

## [0.1.0] - 2026-02-15

### Added

- Initial release
- Basic Feishu bot functionality
- CLI interface
