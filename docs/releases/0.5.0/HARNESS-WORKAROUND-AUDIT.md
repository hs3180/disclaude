# Claude harness workaround audit

Related: #4813, #4826

Audit baseline: `987e4b91` (`origin/main`), 2026-09-09. Installed and locked
`@anthropic-ai/claude-agent-sdk`: `0.3.263`.

This inventory records the compatibility behavior that remains around the
Claude SDK. A passing regression test is evidence that current behavior is
preserved; it is not evidence that the upstream defect disappeared. Removal
requires an upstream changelog/source reference or a real-process regression
that demonstrates the workaround is no longer needed.

## Retained behavior and boundaries

| Concern and source | Current entry point | Configuration / applicability | Audit result |
|---|---|---|---|
| No-content stall (#3706) and first-message blind window (#4442) | `ClaudeSDKProvider.queryStream()` in `sdk/providers/claude/provider.ts`; both timers terminate through `fireWatchdog()` | Claude SDK provider only; `DISCLAUDE_STALL_TIMEOUT_MS` (default 180 s), `DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS` (default 5 s); partial progress depends on `includePartialMessages` set by `BaseAgent.createSdkOptions()` | Retain. The blind timer and content timer cover different stream phases and already share one terminal path. SDK 0.3.263 does not supply this application-level failure result. Timeout parsing is still duplicated in the Codex and Pi providers; move parsing to one provider-neutral helper before claiming full single-entry convergence. |
| Pre-output transient retry (#4192/#4313) and empty-stream retry (#4442) | One retry loop in `ClaudeSDKProvider.queryStream()` with a replay buffer | Claude SDK provider only; `DISCLAUDE_QUERY_MAX_RETRIES` (default 2, 0 disables). Retry is restricted to `messageCount === 0`, before output or tool side effects can be observed | Retain. Both failure modes share one budget and backoff implementation. Do not widen the replay gate without tool-side-effect evidence. |
| Successful SDK result after upstream 5xx (#4322) | `stderrIndicatesUpstreamApiError()` plus the result adaptation branch in `ClaudeSDKProvider.queryStream()` | Claude SDK provider using an upstream/proxy that reports API failure on stderr; no operator switch | Retain. The classifier is a single entry and intentionally excludes authentication failures. No 0.3.263 evidence shows stderr/result disagreement is fixed for custom proxies. |
| Per-query process listener cleanup (#3378) | `snapshotProcessListeners()` before `query()`, then one guarded `cleanupListeners()` callback from iterator `finally`, close, or cancel | Claude SDK provider on Node.js | Retain. Inspection of installed 0.3.263 shows SDK code still registers an `exit` handler (`process.on("exit", ...)`). Real query lifecycle tests remain the removal gate. |
| Process-wide listener baseline cleanup (#3745) | Exported `forceCleanupLeakedListeners()` in `sdk/providers/claude/provider.ts` | No configuration | Not converged: the function and module-load baseline remain exported, but no production caller exists at this baseline. Either restore one documented owner with a reproducer showing per-query cleanup misses, or delete this fallback and its exports after proving the guarded per-query path suffices. Do not maintain two cleanup contracts implicitly. |
| Builtin skills/agents discovery (#4224) | `adaptOptions()` in `sdk/providers/claude/options-adapter.ts` assigns one local plugin rooted at `Config.getBuiltinsDir()` | Claude SDK provider; bundled/discovered builtins root | Retain. It has one injection point and replaces the older copy-on-start race. Configurability is not itself a removal criterion; embedded callers should receive an explicit provider option before changing it. |
| Provider model-tier aliases (#3770) | `BaseAgent.createSdkOptions()` injects the three `ANTHROPIC_DEFAULT_*_MODEL` variables | Claude SDK provider with Task/Team sub-agents, especially non-Anthropic compatible endpoints | Retain pending backend-capability split. It prevents SDK aliases from resolving to unsupported Claude model names. S01 backend routing must ensure non-Claude providers do not inherit these options. |
| Project skill scope (#3532) | `BaseAgent.createSdkOptions()` sets `CLAUDE_CONFIG_DIR` when project-bound | Only when agent cwd differs from the workspace | Retain. This is a conditional single entry; removal needs an SDK-supported settings scope that preserves workspace skills during project switching. |
| Workspace path contract (#3803/#4261) | `BaseAgent.createSdkOptions()` sets `DISCLAUDE_WORKSPACE_DIR`; task-record guidance consumes it | Claude harness and bundled skills that need workspace-owned state while cwd can point at a project | Retain, but the consumer contract is split between environment construction and prompt/skill guidance. A future typed runtime-context contract should replace the private environment variable atomically, not delete only its producer. |
| SDK debug and nested-session environment handling | `buildSdkEnv()` in `utils/sdk.ts` sets `DEBUG_CLAUDE_AGENT_SDK` and deletes `CLAUDECODE` | Claude SDK provider; debug controlled by `logging.sdkDebug` (default behavior enables it) | Retain pending real subprocess tests. These are centralized, but the nested-session deletion and default-debug policy lack issue references in code. Add provenance and verify whether 0.3.263 still rejects inherited `CLAUDECODE` before removal. |

## Outstanding convergence work

1. Extract parsing of the shared stall timeout/grace policy used by Claude,
   Codex, and Pi. Provider-specific progress signals and termination events
   should remain local.
2. Resolve the unused process-wide `forceCleanupLeakedListeners()` contract.
   Its export is a second cleanup entry without a production owner; installed
   SDK source still justifies per-query cleanup, not automatically this fallback.
3. Make BaseAgent option injection capability-scoped as backend selection lands.
   Claude-only model aliases, plugin options, partial-message behavior, and
   environment contracts must not be silently passed to providers that cannot
   honor them.
4. Add provenance and subprocess evidence for `buildSdkEnv()`'s debug default
   and `CLAUDECODE` deletion before changing either behavior.

## Verification map

- Listener cleanup: `sdk/providers/claude/provider.test.ts` cases for normal
  iterator completion and explicit handle close.
- Retry, empty-stream, watchdog, and stderr classification:
  `sdk/providers/claude/provider.test.ts`.
- Builtin local plugin: `sdk/providers/claude/options-adapter.test.ts`.
- Model tier, project config directory, and workspace environment:
  `agents/base-agent.test.ts`.

This audit satisfies the inventory/evidence portion of S07-A2. The outstanding
items above remain implementation work; this document does not mark #4813 or
S07 complete.
