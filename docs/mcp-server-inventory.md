# disclaude MCP Server Inventory (#4459, part 1)

> Parent: **[#4383](https://github.com/hs3180/disclaude/issues/4383)** (pi backend / "reduce MCP" direction,
> owner decision 2026-08-07) · Serves **[#4459](https://github.com/hs3180/disclaude/issues/4459) Scope 1**
> (inventory current MCP server usage) · Type: **inventory / research** (decision-input, no code change).
>
> **This is part 1 of [#4459](https://github.com/hs3180/disclaude/issues/4459)** — the prerequisite
> inventory before any MCP→Skill migration / removal (Scopes 2–4) and before the Playwright sibling
> ([#4460](https://github.com/hs3180/disclaude/issues/4460)) can size its CLI surface. Every claim below
> cites a `file:line` from `main` (HEAD `25a30eb6` at write time). There are **zero web sources** — this is
> pure codebase inventory, not upstream/website research.

Companion docs:

- `docs/pi-mcp-landing-research.md` — the [#4431](https://github.com/hs3180/disclaude/issues/4431) MCP-landing
  research (now **superseded** by the 2026-08-07 "pi will NOT support MCP" decision; kept as historical record).
- `docs/pi-agent-core-api-research.md` — the [#4384](https://github.com/hs3180/disclaude/issues/4384) spike that
  established pi-agent-core has **no native MCP** (entire package `grep -rni mcp` = 0 hits).

---

## TL;DR — the three MCP surfaces

disclaude touches MCP in **three distinct places**. They have different transports, different owners, and
**different retirement profiles** under [#4459](https://github.com/hs3180/disclaude/issues/4459):

| # | Surface | Transport | Lives in | Tools exposed | Spawned/managed by | Retirement profile |
|---|---|---|---|---|---|---|
| **S1** | **`channel-mcp`** — disclaude's own messaging/IPC tools | **inline / in-process** (SDK `createSdkMcpServer`) | `packages/mcp-server/src/channel-mcp.ts` | `send_text`, `send_card`, `send_interactive`, `send_file`, `push_to_agent` (5) | the agent SDK, in-process; disclaude holds the `instance` for teardown | **Migrate → Skill** (these are first-party disclaude tools, the `#4459` Scope 3 "non-Playwright" targets) |
| **S2** | **External stdio MCP servers** (user-configured) | **stdio subprocess** | config `tools.mcpServers`; loader `packages/primary-node/src/agents/mcp-setup.ts` | whatever the server exports (canonical: **Playwright MCP**, ~15 tools) | the agent SDK spawns the subprocess; disclaude has **no handle** on it | **Retire the loader** (`#4459` Scope 4); Playwright migrates separately via `#4460` |
| **S3** | **`@disclaude/mcp-server` as a standalone stdio server** | **stdio** (disclaude *exported* as an MCP server for external clients) | `packages/mcp-server/src/cli.ts` + `stdio-server.ts` (`disclaude-mcp` bin) | `send_text`, `send_card`, `send_interactive`, `send_file`, `push_to_agent` (5, same as S1) | external MCP client (e.g. Claude Code) spawns it | **Out of `#4459` scope** — this is disclaude *as* a server, not disclaude *consuming* one; flagged for owner decision |

Plus the **adapter/transport plumbing** that all three flow through (S4 below), and the **config + health**
surfaces (S5, S6).

---

## S1 — `channel-mcp` (inline / in-process MCP server)

disclaude's **own** MCP server, built in-process and handed to the agent SDK as an inline server. This is the
primary "channel" tool surface (send messages / cards / files into the bound chat, push turns to other agents).

- **Construction**: `createChannelMcpServer()` at
  [`packages/mcp-server/src/channel-mcp.ts:682`](../packages/mcp-server/src/channel-mcp.ts) — delegates to the
  active provider's `createMcpServer({ type: 'inline', name: 'channel-mcp', version: '1.0.0', tools: channelToolDefinitions })`.
- **Tool list** (`channelToolDefinitions`, [`channel-mcp.ts:250`](../packages/mcp-server/src/channel-mcp.ts)):
  `send_text` (`:260`), `send_card` (`:318`), `send_interactive` (`:482`), `send_file` (`:591`),
  `push_to_agent` (`:635`). **5 tools.**
- **Wiring**: `buildMcpServers()` adds it under the key `'channel-mcp'` at
  [`packages/primary-node/src/agents/mcp-setup.ts:53`](../packages/primary-node/src/agents/mcp-setup.ts), gated
  on channel capabilities (`supportedMcpTools`, `mcp-setup.ts:45-52`). `ChatAgent` calls `buildMcpServers()` at
  [`packages/primary-node/src/agents/chat-agent.ts:760`](../packages/primary-node/src/agents/chat-agent.ts).
- **Transport**: inline — the SDK's `createSdkMcpServer` returns a `{ type: 'sdk', name, instance }` wrapper
  (documented at [`packages/core/src/sdk/providers/claude/options-adapter.ts:97`](../packages/core/src/sdk/providers/claude/options-adapter.ts));
  `instance` is an MCP SDK `McpServer` exposing `close()`.
- **Teardown**: disclaude retains the closeable inline instances via `collectInlineMcpInstances()`
  (`mcp-setup.ts:96`) and `close()`s them on `ChatAgent.dispose()` (issue #4302, defense-in-depth).
- **IPC backing**: the tools talk to the Primary Node over IPC via `getIpcClient()`
  ([`channel-mcp.ts:1-10`](../packages/mcp-server/src/channel-mcp.ts) module doc). The IPC transport itself is
  being unified to REST ([#4168](https://github.com/hs3180/disclaude/issues/4168)); that is orthogonal to the
  MCP→Skill retirement (the *tool surface* stays, only the *MCP protocol wrapping* goes away).

> **Migration note (`#4459` Scope 3):** these 5 tools are the "non-Playwright MCP tools" `#4459` Scope 3
> targets. They are first-party disclaude capabilities already implemented in-process; retiring MCP here means
> **re-exposing the same implementations as Skills (CLI + README)** rather than deleting any behavior. The IPC
> plumbing underneath is unaffected.

### Loop-runner tools (legacy, not in the active channel surface)

`channel-mcp.ts` imports and re-exports `loop_start` / `loop_stop` / `loop_status`
([`channel-mcp.ts:33-37`](../packages/mcp-server/src/channel-mcp.ts), from `./tools/loop-{start,stop,status}.ts`,
issue #4075), but **none of them appear in `channelToolDefinitions`** (`channel-mcp.ts:250`) nor in the
standalone server's `tool-definitions.ts` (see S3). They are programmatic exports only, tied to the
**deprecated loop system** ([#4039](https://github.com/hs3180/disclaude/issues/4039) /
[#4430](https://github.com/hs3180/disclaude/issues/4430)). The loop retirement (`#4430`) owns their removal;
`#4459` does not need to touch them.

---

## S2 — External stdio MCP servers (user-configured; Playwright is canonical)

disclaude spawns arbitrary user-configured MCP servers as stdio subprocesses and surfaces their tools to the
agent. This is the surface the "reduce MCP" direction most directly targets, and where Playwright lives.

- **Config type**: `McpServerConfig { command; args?; env? }` at
  [`packages/core/src/config/types.ts:221`](../packages/core/src/config/types.ts) (doc comment `:218`), nested
  under `ToolsConfig.mcpServers` (`types.ts:239`).
- **Config reader**: `Config.getMcpServersConfig()` at
  [`packages/core/src/config/index.ts:521`](../packages/core/src/config/index.ts) (returns
  `fileConfigOnly.tools?.mcpServers`).
- **Loader**: `buildMcpServers()` reads the config and emits one stdio entry per server at
  [`packages/primary-node/src/agents/mcp-setup.ts:62-73`](../packages/primary-node/src/agents/mcp-setup.ts):
  ```ts
  const configuredMcpServers = Config.getMcpServersConfig();
  if (configuredMcpServers) {
    for (const [name, config] of Object.entries(configuredMcpServers)) {
      mcpServers[name] = { type: 'stdio', command: config.command, args: config.args || [], ...(config.env && { env: config.env }) };
    }
  }
  ```
- **Transport / spawning**: stdio. disclaude **does not** spawn the subprocess itself and holds **no handle** on
  it — the agent SDK spawns it inside the CLI child. This is why `collectInlineMcpInstances()` skips stdio
  entries (only inline `{instance}` wrappers are closeable; see `mcp-setup.ts:96` doc).
- **Canonical consumer — Playwright MCP**: declared in
  [`disclaude.config.example.yaml:257-261`](../disclaude.config.example.yaml):
  ```yaml
  playwright:
    type: "stdio"
    command: "npx"
    args: ["@playwright/mcp@latest", "--cdp-endpoint", "http://disclaude-playwright:9222"]
  ```
  Dependency pinned at [`packages/core/package.json`](../packages/core/package.json):
  `"@playwright/mcp": "^0.0.61"` (lockfile `playwright 1.59.0-alpha`). README advertises "Playwright MCP
  (15+ tools)" ([`README.md:40`](../README.md), [`:270`](../README.md), [`:535`](../README.md)). Tool-name
  convention `mcp__playwright__browser_*` documented at [`SKILL_SPEC.md:625-628`](../SKILL_SPEC.md) and granted
  to the `site-miner` agent at [`CLAUDE.md:531`](../CLAUDE.md).
- **Custom servers**: the example shows a generic custom-stdio template
  ([`disclaude.config.example.yaml:263-268`](../disclaude.config.example.yaml)).

> **Migration note (`#4459` Scope 4 + `#4460`):** this is the "external MCP-server loader" `#4459` Scope 4
> deprecates/removes. Playwright (the dominant consumer) migrates to a Skill via sibling
> [#4460](https://github.com/hs3180/disclaude/issues/4460); arbitrary user stdio servers have **no automatic
> migration path** (a generic stdio→Skill converter would be the closed #4417 "bridge", which the 2026-08-07
> decision dropped) — `#4459` must record this capability loss explicitly rather than silently.

---

## S3 — `@disclaude/mcp-server` as a standalone stdio server (disclaude *exported*)

The `@disclaude/mcp-server` package is **also** shipped as a standalone stdio MCP server binary (`disclaude-mcp`)
that **external** MCP clients (Claude Code, etc.) can spawn to get disclaude's channel tools. This is the
inverse direction from S1/S2: disclaude *is* the MCP server, not the consumer.

- **Package**: [`packages/mcp-server/package.json`](../packages/mcp-server/package.json) — `"bin":
  { "disclaude-mcp": "./dist/cli.js" }`, description "MCP Server process for disclaude - provides MCP tools and
  resources".
- **CLI entry**: [`packages/mcp-server/src/cli.ts`](../packages/mcp-server/src/cli.ts) — "starts the MCP Server
  (stdio mode) for use with Claude Code and other MCP clients" (module doc, `cli.ts:7-12`).
- **Transport**: stdio JSON-RPC over stdin/stdout, implemented in
  [`packages/mcp-server/src/stdio-server.ts`](../packages/mcp-server/src/stdio-server.ts) (newline-delimited
  JSON-RPC; `cli.ts` does arg parsing + handshake + routing, `stdio-server.ts` is the transport).
- **Tool list**: `toolDefinitions` at
  [`packages/mcp-server/src/tools/tool-definitions.ts`](../packages/mcp-server/src/tools/tool-definitions.ts) —
  `send_text` (`:28`), `send_card` (`:50`), `send_interactive` (`:90`), `send_file` (`:165`),
  `push_to_agent` (`:187`). **Same 5 tools as S1**, dispatched via `tool-dispatch.ts`.
- **IPC backing**: same as S1 — tools reach the Primary Node over IPC (`getIpcSocketPath()`, loaded in `cli.ts`).

> **Scope flag (`#4459`):** S3 is **disclaude-as-server**, which is a *product surface* (letting external MCP
> clients drive disclaude), not disclaude *consuming* MCP. The `#4459` "retire MCP server support" title is
> about disclaude's *consumption* of MCP (S1 inline wrapping + S2 external loader). Whether S3 (the standalone
> server product) stays, becomes a Skill-host, or is removed is a **separate owner decision** — this inventory
> surfaces it but does not presuppose the answer.

---

## S4 — Adapter / transport plumbing (shared by all surfaces)

The path every MCP server config takes from `buildMcpServers()` → agent SDK.

- **Provider interface**: `IAgentSDKProvider.createMcpServer(config: McpServerConfig)` at
  [`packages/core/src/sdk/interface.ts:85`](../packages/core/src/sdk/interface.ts) (alongside
  `createInlineTool` at `:75`). Every backend must implement it.
- **Unified option type**: `SdkMcpServerConfig` (`mcpServers?` field) at
  [`packages/core/src/sdk/types.ts:263`](../packages/core/src/sdk/types.ts); threaded through
  `BaseAgentOptions` at [`packages/core/src/agents/base-agent.ts:202-203`](../packages/core/src/agents/base-agent.ts).
- **Claude adapter**: `adaptMcpServers()` at
  [`packages/core/src/sdk/providers/claude/options-adapter.ts:124`](../packages/core/src/sdk/providers/claude/options-adapter.ts)
  handles **three** input shapes — (1) an already-built SDK inline wrapper (`isSdkInlineMcpServer`, `:103`),
  (2) an `inline` config → `createSdkMcpServer` (`:159`, `:172`), (3) a `stdio` config → passed through. This
  is where S1 (inline) and S2 (stdio) diverge into their respective SDK code paths.
- **pi adapter (parity state)**: `PiAgentProvider.createMcpServer()` at
  [`packages/core/src/sdk/providers/pi/provider.ts:84`](../packages/core/src/sdk/providers/pi/provider.ts):
  - `type === 'inline'` → returns a `{ name, version, tools }` handle built from `createInlineTool`
    (`provider.ts:85-103`, issue #4417 S4 part 1).
  - `stdio` → **throws** `'stdio MCP servers are not supported by PiAgentProvider.createMcpServer'`
    (`provider.ts:106-110`).
  - Per the 2026-08-07 owner decision, **pi will NOT support MCP at all** — the inline handle stays as the
    Skills-compatible tool path, stdio stays unsupported. So under `#4459`, the pi path needs **no MCP-removal
    work** (it never gained stdio); only the Claude path (S1+S2) carries retirement work.

---

## S5 — Health tracking

- [`packages/core/src/agents/mcp-health-tracker.ts`](../packages/core/src/agents/mcp-health-tracker.ts) tracks
  consecutive failures per tool and marks a tool **degraded** past a threshold (default 2, issue #4179; fast-trip
  predicate can degrade immediately). A degraded tool is excluded for the rest of the session. The test fixture
  ([`mcp-health-tracker.test.ts:103`](../packages/core/src/agents/mcp-health-tracker.test.ts)) names
  `playwright` and `web_reader` as tracked tools — i.e. health tracking is tool-name keyed and applies to S2
  external tools (Playwright) regardless of which server exports them.

> **Migration note:** health tracking is **tool-name keyed**, not MCP-protocol keyed. Migrating Playwright to a
> Skill preserves the tool names (`browser_navigate` etc. → Skill subcommands) only if the Skill deliberately
> keeps them; otherwise health-tracking coverage and the `site-miner` permission grants (`CLAUDE.md:531`) need
> coordinated updates. `#4460` owns that coordination.

---

## S6 — Config + docs surface (mentions to keep honest)

Files that reference MCP and will need editing as the retirement lands (so docs do not silently drift):

- `disclaude.config.example.yaml:249-268` — the `mcpServers` block (Playwright + custom example).
- `README.md:24,40,270,504,506,535` — "Browser automation - Playwright MCP tools", "Playwright MCP (15+ tools)".
- `SKILL_SPEC.md:625-628` — `mcp__playwright__*` tool-name convention.
- `CLAUDE.md:531` — `site-miner` agent permissions include `mcp__playwright__*`.
- `packages/core/src/config/types.ts:218-239` — `McpServerConfig` (`:221`) / `ToolsConfig.mcpServers` (`:239`) types.
- `packages/core/src/config/index.ts:521` — `getMcpServersConfig()` reader.

---

## What this means for #4459 (retirement sequencing)

Mapping the inventory to `#4459`'s four scopes:

| `#4459` Scope | This inventory surface | Concrete code touch-points |
|---|---|---|
| **1. Inventory** ✅ (this doc) | all | `docs/mcp-server-inventory.md` (new) |
| **2. Skill format spec** | n/a (defines the target) | new `docs/...` spec (deferred — independent of this inventory) |
| **3. Migrate non-Playwright MCP tools → Skill** | **S1** (channel-mcp, 5 tools) | re-expose `send_text`/`send_card`/`send_interactive`/`send_file`/`push_to_agent` as Skills; the in-process implementations + IPC backing stay |
| **4. Remove external MCP-server loader** | **S2** (stdio loader) | delete the `mcp-setup.ts:62-73` config loop + `getMcpServersConfig()` + `McpServerConfig`/`ToolsConfig.mcpServers` types + yaml example; record the user-stdio capability loss |

**Not owned by #4459** (called out so nothing is silently dropped):

- **Playwright** (the dominant S2 consumer) → sibling [#4460](https://github.com/hs3180/disclaude/issues/4460).
- **S3 standalone server** (disclaude-as-server product) → owner decision (stay / Skill-host / remove).
- **Loop tools** (`loop_start/stop/status`) → deprecated loop system [#4430](https://github.com/hs3180/disclaude/issues/4430).
- **pi backend MCP parity** → already settled (no MCP; inline handle only). No retirement work.

### Open questions this inventory raises for #4459 Scope 2+

1. **Skill transport for S1's send-side tools**: the channel tools push *into* a bound chat over IPC. A Skill
   (CLI) needs the same IPC reach-back — is the Skill a long-lived process or one-shot per call? (Affects
   latency / connection reuse for `send_text` etc.)
2. **Capability gating**: S1 is gated on `supportedMcpTools` (`mcp-setup.ts:45-52`). Does the Skill replacement
   keep per-chat capability filtering, or does moving to a CLI lose that granularity?
3. **S3 product decision**: is `disclaude-mcp` (standalone server) still a supported product after the Claude
   path stops *consuming* MCP? (If yes, S3 stays even as S1/S2 retire.)
4. **User-stdio capability loss (S2)**: with the #4417 bridge dropped, arbitrary user `tools.mcpServers` stdio
   servers have no migration path. `#4459` Scope 4 must state this as an accepted capability loss (or defer a
   replacement), not remove it silently.
