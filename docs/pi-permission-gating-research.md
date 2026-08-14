# Permission Gating Paradigm for the pi Backend — Research (#4432)

> Serves #4383 decision **(c) permission gating**. Parent: #4383. Implementation issue: #4389.
> **This is part 1** — it delivers **C-Q1 (Claude gating baseline audit)** + **C-Q2 (pi-ecosystem permission status, re-verified on `pi-agent-core@0.83.0`)** + the **threat model** + a **preliminary candidate-paradigm map**. **C-Q3 (industry-paradigm benchmarking — Codex / Aider / Cursor / Claude Agent SDK hooks) and the final C1/C2/C3 recommendation are deferred to part 2** (they require web research against external SDK docs; this part stays strictly grounded in the repo + the installed pi tarball, no speculation).
> **Part 2** (merged) corrected C-Q2.2 (pi-agent-core exposes a native `beforeToolCall` deny hook, C-Q2.5) and audited the `pi-coding-agent` CLI gating model (C-Q2.6).
> **Part 3 (2026-08-08) revises the threat model + candidate map for the 2026-08-07 MCP-removal decision** — see the [Part 3 addendum](#part-3-addendum-2026-08-08-mcp-retired--gating-surface-shrinks-to-inline-only). Summary: the pi backend will **not** support MCP (#4417 closed won't-do), so the only tool path left to gate is **inline tools (#4387)**; the "MCP converter must not become a bypass" invariant is now moot. C-Q3 (industry benchmarking) remains web-deferred and is **not** touched by part 3.

---

## TL;DR

1. **disclaude does not itself enforce tool permissions today — not on the Claude path, and (a fortiori) not on the pi path.** The Claude backend *delegates* the entire permission contract to the Claude Agent SDK subprocess via three options (`permissionMode` / `allowedTools`+`disallowedTools` / `settingSources`), and `IAgentSDKProvider` exposes **no permission surface at all**. There is no `canUseTool` / pre-tool-call hook anywhere in `packages/core` or `packages/primary-node`.
2. **The default permission mode is `bypassPermissions`** (`base-agent.ts:136`). So "the Claude backend gates tools" is, in practice, "the SDK is *configured* to gate, and disclaude asks it not to." This re-frames #4389's premise ("audit how Claude enforces, replicate on pi"): there is little disclaude-owned enforcement to replicate — the real task is to **build** a gating layer that both backends can share.
3. **`pi-agent-core@0.83.0` (newer than the spike's 0.82.1) still has no permission / approval / allowlist / pre-tool-call system.** ⚠️ **(part 2 corrected this — see C-Q2.5: pi-agent-core *does* expose an unlabeled `beforeToolCall` deny hook; the "no pre-tool-call" wording below is superseded for that one point.)** The only `permission` token in the whole package is a `FileErrorCode = "permission_denied"` enum value (POSIX-style error, not a gate). What pi *does* expose is a pluggable **`FileSystem` + `Shell`** environment (`ExecutionEnv`) — the natural injection point for OS-level / sandbox-style gating.
4. The pi provider skeleton already implements a **coarse tool-name allowlist** (`allowedTools` − `disallowedTools` → pi's active-tool set), and explicitly defers runtime gating to #4389 (`providers/pi/options-adapter.ts:39`). So today the pi path has tool-*enumeration* filtering but **no per-call permission decision**.
5. **Threat-model bottom line:** with `agentBackend = pi`, **disclaude is the sole permission authority** (pi inherits the launcher's perms and never asks). Any gating must live in disclaude-owned code that **every** tool invocation routes through — in particular the MCP→pi converter injection point (#4417) must not become a bypass. ⚠️ **(part 3 — superseded)** #4417 is closed won't-do (2026-08-07 decision: the pi backend will not support MCP); the only tool path left to gate is **inline tools (#4387)**. See the Part 3 addendum.

---

## C-Q1 — Current Claude gating baseline (audit)

> Question: *disclaude Claude backend 当前到底怎么 gate 工具的？pre-tool-call hook 在哪、allowlist 怎么配、bash/browser 如何受限？*

### C-Q1.1 The provider abstraction carries no permission surface

`IAgentSDKProvider` (`packages/core/src/sdk/interface.ts`) declares `queryStream` / `createInlineTool` / `createMcpServer` / `validateConfig` / `dispose` / `getInfo`. A grep for `permission|canUse|allow|deny|gate` across the interface returns **nothing** — gating is deliberately **not** part of the backend contract. Each provider is free to handle (or not handle) permissions its own way.

### C-Q1.2 disclaude has no custom pre-tool-call hook

```
grep -rn "canUseTool|preToolUse|PreToolUse|onToolCall|permissionHook" \
  packages/core/src packages/primary-node/src   # → 0 hits (non-test)
```

There is **no** disclaude-owned interceptor that inspects a tool call before it runs. Whatever gating happens is whatever the underlying SDK does internally.

### C-Q1.3 The Claude backend delegates three knobs to the Claude Agent SDK

In `packages/core/src/sdk/providers/claude/options-adapter.ts`, `adaptOptions()` maps three permission-related fields straight through to the SDK `query()` options:

| Field | Source | options-adapter.ts | What it does (inside the SDK subprocess) |
|---|---|---|---|
| `permissionMode` | `AgentQueryOptions.permissionMode` (`sdk/types.ts:248`, type `PermissionMode = 'default' \| 'bypassPermissions'` at `:226`) | `:31-33` | Selects the SDK's own permission policy (`default` = prompt/allowlist-driven; `bypassPermissions` = run everything). |
| `allowedTools` / `disallowedTools` | `AgentQueryOptions` (`:250` / `:252`) | `:54-60` | The SDK's tool allow/deny list (e.g. `Bash`, `Read`, `mcp__playwright__*`). |
| `settingSources` | `AgentQueryOptions.settingSources` (`:274`, **required**) | `:47` | Tells the SDK where to load `.claude/settings.json` permission rules from. |

These flow into the SDK at `providers/claude/provider.ts:389-391`:

```ts
let queryResult = query({ options: sdkOptions as ...['options'], ... });
```

**Enforcement (the actual allow/deny decision, the `canUseTool` callback, user prompts) happens inside the Claude Agent SDK subprocess — not in disclaude's TypeScript.** disclaude only *configures* it.

### C-Q1.4 The effective default is "no gating"

`packages/core/src/agents/base-agent.ts:136`:

```ts
this.permissionMode = config.permissionMode ?? 'bypassPermissions';
```

The config schema (`config/types.ts:50`) exposes `permissionMode?: 'default' | 'bypassPermissions'` to the user, but unless they opt into `'default'`, every agent boots in `bypassPermissions`. `base-agent.ts:187` then forwards `permissionMode` into `AgentQueryOptions`.

### C-Q1.5 What this means for #4389's premise

#4389 acceptance item 1 says: *"Audit how the Claude backend enforces permissions today and replicate that contract on the pi path."* The audit finding inverts the premise:

- There is **no disclaude-owned enforcement to replicate** — only an SDK-delegation pattern and a default that disables gating.
- The honest, useful deliverable is therefore **not** "copy Claude's gate onto pi" (there is no Claude gate in disclaude to copy) but **"design a disclaude-owned gating layer that both backends can share,"** with the Claude path optionally tightening its default away from `bypassPermissions`.

This is the single most important output of C-Q1 and should reshape #4389's scope before implementation.

---

## C-Q2 — pi-ecosystem permission/sandbox status (re-verified on 0.83.0)

> Question: *pi 生态有无任何权限/沙箱机制（pi-coding-agent CLI 的 gating / community sandbox / tool-level allowlist / permission hook）？*
> Method: `npm view @earendil-works/pi-agent-core version` → pack tarball → `grep` dist. (The spike #4384 stopped at 0.82.1; pi iterates fast, so this re-checks the current version.)

### C-Q2.1 Current version

```
npm view @earendil-works/pi-agent-core version   # → 0.83.0   (spike used 0.82.1)
```

The version has bumped since the spike; the permission question was re-verified against 0.83.0.

### C-Q2.2 No permission/approval/allowlist/pre-tool-call system ⚠️ (the pre-tool-call point is corrected in C-Q2.5: pi-agent-core does expose a `beforeToolCall` deny hook)

Across `package/dist/**/*.d.ts`:

```
grep -rli "permission|sandbox|approveTool|allowlist|canUse|deny|securityPolic" package/dist
# → only: harness/types.d.ts, harness/env/nodejs.d.ts (+ their .map files)
```

The only `permission` tokens are:

- `harness/types.d.ts:91` — `FileErrorCode = "aborted" | "not_found" | "permission_denied" | ...` — a **POSIX-style error code** for filesystem ops, not a gating mechanism.
- `harness/types.d.ts:185` — a doc comment on `FileSystem` noting that permission failures surface as `FileError`.

A targeted search for any per-call gating hook:

```
grep -n "canExecute|onTool|beforeTool|preTool|approve|permission|interceptor|middleware" \
  package/dist/harness/types.d.ts          # → only the two FileErrorCode hits above
```

→ **pi-agent-core@0.83.0 has no `canUseTool` / approval / allowlist / pre-tool-call / interceptor / middleware hook.** The spike's 0.82.1 conclusion ("no native permission system") **still holds at 0.83.0.**

### C-Q2.3 What pi *does* expose: a pluggable execution environment

`harness/types.d.ts` declares backend-agnostic interfaces that the harness calls instead of Node directly:

```
:159  export interface FileSystem { ... }      // read/write/list — disclaude can implement
:227  export interface Shell { ... }           // exec — disclaude can implement
:238  export interface ExecutionEnv extends FileSystem, Shell { ... }
```

This is the **only** structural surface pi offers for restricting what an agent can do: if disclaude supplies a custom `ExecutionEnv` (a `Shell` that refuses disallowed commands, a `FileSystem` that confines writes), it gets OS-level / sandbox-style gating **without** pi ever needing a permission concept. This maps directly onto paradigm **(d) OS-level sandbox** in C-Q4 (part 2).

### C-Q2.4 What the pi provider already does (coarse tool-name allowlist)

`packages/core/src/sdk/providers/pi/options-adapter.ts` already maps a *static* allow/deny list into pi's active-tool set:

- `:39` — comment: *"permissionMode / permission gating: #4389 (S6); pi has no built-in perms."*
- `:86-177` — resolves `allowedTools` (or string-array `tools`) **minus** `disallowedTools` → the tool names pi's `agentLoop` is allowed to call.

So today the pi path has **tool-enum filtering** (a tool not in the list is never offered to the model) but **no runtime permission decision** (a tool *in* the list runs unchecked, including any bash/browser it backs). `permissionMode` is explicitly dropped (`:39-40`, "Claude-only field with no pi agentLoop-level meaning").

### C-Q2.5 ⚠️ Correction (part 2): pi-agent-core DOES expose a `beforeToolCall` deny hook

**Part 1's C-Q2.2 ("No permission/approval/allowlist/pre-tool-call system") was wrong on the pre-tool-call point.** Part 1 grepped the tarball for the *labels* `permission|sandbox|allowlist|approve` and found none — but pi-agent-core's actual gating surface is an **unlabeled `beforeToolCall` / `afterToolCall` hook pair** on the `Agent`. Re-verifying `@earendil-works/pi-agent-core@0.83.0`:

- **`dist/types.d.ts:37`** — *"Returning `{ block: true }` prevents the tool from executing. The loop emits an error tool result instead."*
- **`dist/types.d.ts:40-43`** — `BeforeToolCallResult { block?: boolean; reason?: string; }` — a real **deny** return (`block:true` aborts execution; `reason` becomes the error text the model sees).
- **`dist/types.d.ts:69-79`** — `BeforeToolCallContext { assistantMessage; toolCall; args; context; }`. Notably `args` (lines 75-76) is the **schema-validated tool arguments** — so the hook can inspect *which* bash command / which URL, not just the tool name.
- **`dist/agent.d.ts:13`** — `beforeToolCall?` is an optional field of the Agent runtime options (set at construction; `agent.js:122` assigns `this.beforeToolCall = runtimeOptions.beforeToolCall`).
- **`dist/agent-loop.js:405-406`** — the loop **does** invoke it, *after* argument validation, *before* execution: `if (config.beforeToolCall) { const beforeResult = await config.beforeToolCall({ assistantMessage, toolCall, args: validatedArgs, context }, signal); … }`.
- **`dist/types.d.ts:45-67` + `agent.d.ts:14`** — symmetric `afterToolCall` can rewrite/replace a tool result (`content` / `details` / `isError` / `terminate`) after execution — a post-hoc redaction/override capability.

**Implication for #4389:** disclaude does **not** need to build gating purely as a tool-wrapper (paradigm (b)) or rely on the coarse allowlist (c). It can set the `PiAgent`'s `beforeToolCall` to disclaude's gate and return `{ block: true, reason }` to deny — **paradigm (a), natively supported by the embedded package, no MCP-style converter required.** Because the hook fires in-loop before *every* tool execution, MCP-injected tools (the #4417 inline path) pass through it too — threat-model invariant #2 holds at this layer. (Caveat: disclaude's `PiAgentProvider.queryStream` (#4386) still throws `NOT_IMPLEMENTED` at repo HEAD `e723b8d`, so the Agent is not yet constructed on the pi path; wiring `beforeToolCall` is gated on #4386 going live, same as the rest of the pi loop.)

### C-Q2.6 `pi-coding-agent` CLI gating model (closes deferred item #3)

The official CLI built on the same `pi-agent-core` is itself a real-world data point for "how does an in-process/CLI agent gate tool execution?" Auditing `@earendil-works/pi-coding-agent@0.83.0` (`npm pack`, grepped `package/dist`):

| Layer | Mechanism | Evidence | Granularity |
|---|---|---|---|
| **Project trust** | Persistent per-project-path boolean: trust is *required* when a project ships local resources under `cwd/.pi` or `.agents/skills`; the user/global `~/.agents/skills` is always trusted. | `dist/core/trust-manager.d.ts` (`ProjectTrustDecision = boolean\|null`, `ProjectTrustStore.get/set`, `hasTrustRequiringProjectResources`); `dist/core/extensions/types.d.ts:233-234` (`isProjectTrusted()`), `:386-401` (`ProjectTrustEvent`/`ProjectTrustContext`) | **Coarse** — trusts the whole workspace, not individual calls |
| **Tool allowlist / denylist** | Optional allowlist (only those tool names exposed) + optional denylist (applied after the allowlist). | `dist/core/sdk.d.ts:27,35,42`; `dist/core/agent-session.d.ts:127,129` | **Tool-name only** (same shape disclaude's pi provider already does, C-Q2.4) |
| **`beforeToolCall` extension bridge** | The CLI installs its own `beforeToolCall` on the pi Agent that fans out to its **extension system** (`tool_call` handlers). With no handler registered it returns `undefined` (passthrough, no gating). | `dist/core/agent-session.js:215` (`this.agent.beforeToolCall = async ({ toolCall, args }) => { … runner.emitToolCall(...) }`) — wraps C-Q2.5's core hook | Extensible to per-call, incl. args |
| **Interactive confirmation (TUI only)** | `confirm(title, message)` dialog; only available in interactive mode (`hasUI`). | `dist/core/extensions/types.d.ts:71-72` | Per-prompt, human-in-the-loop — **not available on the in-process/SDK path disclaude uses** |
| **(No OS-level sandbox for tools)** | The only `sandbox` symbol is `dist/bun/restore-sandbox-env.d.ts`, which restores env vars when running *inside Bun's* sandbox (an env-quirk handler), **not** a tool-execution sandbox. | `dist/bun/restore-sandbox-env.d.ts:5,16` | n/a |

**Takeaway:** pi's *own* answer to "gate the agent" is **project-trust (coarse workspace trust) + tool-name allowlist/denylist + an extension `beforeToolCall` bridge + interactive confirm (TUI-only)**. It does **not** reach for an OS-level sandbox (paradigm (d)) for tool execution, and the in-process surface it exposes to embedders is exactly the `beforeToolCall` hook (C-Q2.5) the CLI itself builds on. This is an ecosystem precedent — not an independent industry benchmark (same pi family) — so C-Q3's external survey (Claude SDK / Codex / Aider / Cursor) remains deferred for cross-vendor comparison.

---

## Part 3 addendum (2026-08-08): MCP retired → gating surface shrinks to inline-only

> **Decision (owner, 2026-08-07, [hs3180/disclaude#4383 comment 5208309432](https://github.com/hs3180/disclaude/issues/4383#issuecomment-5208309432)):** the pi backend will **not** support MCP. This aligns with the disclaude "reduce MCP" direction and pi's design philosophy (no MCP — use Skills). It reverses the prior B1 decision (build a full MCP→`AgentHarnessTool` converter preserving Playwright/custom-stdio/inline-channel parity).

**What closed (the change of state this part records):**

| Item | Before part 3 | After the 2026-08-07 decision |
|---|---|---|
| **#4417** (MCP→`AgentHarnessTool` converter) | Open — assumed to be the pi path's MCP injection point | **Closed `not_planned` (won't-do)** — the converter is no longer needed because the pi backend drops MCP. |
| **#4387** (`createInlineTool` / `adaptInlineTool`) | One of two tool paths (inline) | **Elevated to the sole/primary tool path** for pi (the Skills-compatible mechanism, not MCP protocol). Adapter present at `providers/pi/inline-tool-adapter.ts:158`. |
| **#4431 / #4384** (MCP landing research / spike) | Open | **Closed** (B1 recommendation superseded; MCP-non-native conclusion reinforced). |
| **New work** | — | **#4459** (retire disclaude's MCP-server support → Skills) + **#4460** (replace Playwright MCP with a Playwright Skill) are the actual "reduce MCP" deliverables. |

**How this changes the threat model below (invariant #2) and the candidate map (rows a/b):**

- **Invariant #2 is now moot as written.** Parts 1–2 framed the "MCP→pi converter" (#4417) as the critical choke point that must not become a bypass. With #4417 closed and MCP dropped, **there is no MCP converter on the pi path at all** — the only injection point is the inline-tool adapter (#4387). The invariant reduces to: *the inline-tool adapter must route every tool's `execute` through the gate.* The spirit (no tool reaches the OS/browser ungated) is unchanged; the surface area shrinks.
- **The browser surface moves from "Playwright MCP" to "Playwright Skill" (#4460).** Invariant #3's "Playwright MCP (drives a browser)" example is no longer accurate for the pi path — browser driving migrates to a Skill. The high-risk capability (arbitrary browser automation) persists; only the delivery vehicle changes. A Skill-backed browser is still ultimately a tool/`execute` the inline path must gate.
- **The preliminary recommendation is strengthened, not weakened.** Part 2's lean — set `PiAgent.beforeToolCall` (C-Q2.5) to deny per-call — was justified partly by "covers inline + MCP uniformly." With MCP gone, the same hook now covers **the entire** (single) tool path; there is no second injection point to also secure. Candidate (b) (tool-wrapper at injection) likewise narrows from "#4417/#4387" to "#4387 only."

**What part 3 does *not* do (honest scope):**

- **C-Q3 (industry-paradigm benchmarking) is untouched.** It remains deferred — it requires reading external SDK docs (web) and the doc's stance is "no unsourced claims." The 2026-08-07 decision does not supply that external data; it only changes the in-repo surface. A future part that can cite external docs should still do C-Q3 (Claude Agent SDK hooks / Codex sandbox / Aider / Cursor) before the final C1/C2/C3 call.
- **The final C1/C2/C3 recommendation is still not made.** Part 2's preliminary lean (beforeToolCall hook primary; allowlist/arg-policy as feeders; `ExecutionEnv` sandbox as bash backstop) holds, and is modestly reinforced by the smaller surface — but C-Q3 gating still applies.
- **#4389 (implementation) remains blocked** on #4386 (`PiAgentProvider.queryStream` still throws `NOT_IMPLEMENTED`, re-verified on current main at `providers/pi/provider.ts:74`). The decision does not unblock the loop; it only simplifies what the gate must cover once the loop is live.

---

## Part 4 addendum (2026-08-13): C-Q3.1 — Claude Agent SDK permission-hook surface (installed-tarball evidence)

> **Scope:** answers the **Claude Agent SDK** portion of deferred item C-Q3 — the one C-Q3 vendor whose SDK is an installed dependency (`@anthropic-ai/claude-agent-sdk@0.3.177`, pinned at `packages/core/package.json:19`), so it is inspectable locally without web sources. The other three C-Q3 vendors (OpenAI Codex sandbox / Aider / Cursor) remain **web-deferred** (Deferred §1). No web sources used; every claim cites `sdk.d.ts:line` of the installed tarball or a repo `file:line`.

C-Q1.3 established that disclaude's Claude backend only *configures* the SDK (`permissionMode` / `allowedTools`/`disallowedTools` / `settingSources` via `options-adapter.ts:31-60`) and that "the `canUseTool` callback … happens inside the Claude Agent SDK subprocess — not in disclaude's TypeScript." Re-reading the SDK's own type declarations refines that framing: **the SDK exposes two programmatic, embedder-settable permission surfaces that disclaude does not currently use** — so disclaude is not forced into passive delegation; it could inject a disclaude-owned gate on the Claude path too.

### C-Q3.1.1 `canUseTool` — a programmatic pre-tool-call callback (direct analog of pi's `beforeToolCall`)

`sdk.d.ts:188` declares (JSDoc at `:184-185`: *"Permission callback function for controlling tool usage. Called before each tool execution to determine if it should be allowed."*):

```ts
export declare type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {
  signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string;
  decisionReason?: string; title?: string; displayName?: string; description?: string;
  toolUseID: string; agentID?: string; /* … */
}) => Promise<PermissionResult>;
```

- It is an **Options field**, not an internal-only detail: `canUseTool?: CanUseTool` on the SDK `Options` (`sdk.d.ts:1349`) — an embedder passes it to `query({ options })`, exactly where disclaude already passes `permissionMode` (`providers/claude/options-adapter.ts:31-33`).
- `PermissionResult` (`sdk.d.ts:2075`) is a tagged union: `{ behavior: 'allow'; updatedInput?; updatedPermissions? } | { behavior: 'deny'; message; interrupt? }`. **Allow can rewrite the tool input** (`updatedInput`); **deny carries a reason and may interrupt** — richer than pi's `beforeToolCall` deny shape `{ block: true, reason }` (C-Q2.5), which cannot rewrite args.
- disclaude does **not** set it: `grep -rniE 'canUseTool|PreToolUse|\bhooks\b' packages/core/src/sdk/providers/claude/` → 0 hits. Today the SDK therefore falls back to its internal `permissionMode` policy (default `bypassPermissions` per `base-agent.ts:136`).

**This is the structural twin of pi's `beforeToolCall` (C-Q2.5):** same shape — embedder supplies a per-call callback receiving `(toolName, args)` and returning allow/deny. The Claude path could host a disclaude-owned gate with no adapter/protocol work.

### C-Q3.1.2 `hooks` — a second, richer programmatic surface (PreToolUse → permissionDecision)

The SDK also exposes an in-process hook system: `hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>` on `Options` (`sdk.d.ts:1490`). `HookEvent` (`:821`) enumerates 30 events including **`PreToolUse`**, `PostToolUse`, `PermissionRequest`, `PermissionDenied`. A `PreToolUse` hook's output may carry `permissionDecision?: HookPermissionDecision` (`PreToolUseHookSpecificOutput`, `sdk.d.ts:2216-2218`), where `HookPermissionDecision = 'allow' | 'deny' | 'ask' | 'defer'` (`sdk.d.ts:827`).

- `PreToolUse` fires **before** tool execution and can deny (`permissionDecision: 'deny'`), so it is a second programmable gate — distinct from `canUseTool` in that it is array-valued, runs as async hook callbacks, and can also `ask`/`defer`. The SDK notes PreToolUse-hook denies **bypass `canUseTool`** (`sdk.d.ts:3758`, JSDoc on the auto-deny event: *"PreToolUse hook denies bypass canUseTool and are not covered here."*).
- disclaude registers **no** `hooks` either (same 0-hit grep above).

### C-Q3.1.3 `PermissionMode` is a 6-value enum, not the 2 disclaude models

`sdk.d.ts:2053`: `PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'`. disclaude's mirror type (`packages/core/src/sdk/types.ts:226`) models only `'default' | 'bypassPermissions'`. The unread values are material to a non-interactive embedder: **`dontAsk`** denies anything not pre-allowed (headless deny-all); **`auto`** auto-approves via classifier. A future disclaude-owned gate on the Claude path could pin `dontAsk` and funnel every decision through `canUseTool` — the SDK already supports that combination.

### C-Q3.1.4 Cross-vendor implication (for the eventual C1/C2/C3 call)

With this data point, the "programmatic pre-tool-call deny callback" paradigm now has **three independent confirmations** — Anthropic Claude SDK `canUseTool` (here), `pi-agent-core` `beforeToolCall` (C-Q2.5), and the `pi-coding-agent` CLI `beforeToolCall` extension bridge (C-Q2.6) — and the Claude SDK additionally offers the richer `hooks`/`PreToolUse` surface. This is the **first non-pi-family** C-Q3 data point, so it modestly strengthens the preliminary lean (paradigm (a): a per-call pre-tool hook as the primary gate, with allowlist/arg-policy as feeders, `ExecutionEnv` sandbox as bash backstop). It does **not** by itself finalize C1/C2/C3 — the Codex/Aider/Cursor comparison (Deferred §1) is still needed for a genuine cross-vendor matrix, and one confirming vendor is not a benchmark.

### What part 4 does *not* do (honest scope)

- **C-Q3 is not closed.** Only the Claude Agent SDK sub-question is answered here. OpenAI Codex sandbox / Aider / Cursor remain web-deferred (Deferred §1).
- **The final C1/C2/C3 recommendation is still not made** (depends on the rest of C-Q3).
- **No claim about whether disclaude *should* set `canUseTool`/`hooks` on the Claude path** — that is a #4389 design decision (it would tighten the Claude backend's current `bypassPermissions` default). Part 4 only establishes the surface exists and is currently unused.

---

## Part 5 addendum (2026-08-14): C-Q3.2 + C-Q3.3 — OpenAI Codex CLI & Aider permission models (sourced)

> **Scope:** advances C-Q3 from 1/4 vendors (Claude Agent SDK, part 4) to **3/4** by adding the two CLI-style agents most analogous to disclaude ("in-process TS agent that must gate bash + browser"): **OpenAI Codex CLI** (C-Q3.2) and **Aider** (C-Q3.3). **Cursor is deferred** (see "What part 5 does not do"). No final C1/C2/C3 recommendation is made — this part only gathers cross-vendor evidence and updates the preliminary lean, exactly as parts 3–4 did. **Every claim is sourced**: Codex claims cite either the `openai/codex` Rust source (`codex-rs/protocol/src/protocol.rs`, primary) or OpenAI developer docs; Aider claims cite `aider.chat` docs. Unlike parts 1–4 (repo + installed tarball, no web), this part necessarily uses external web sources — all reachable & fetched 2026-08-14 (see Evidence provenance); nothing is asserted from memory.

### C-Q3.2 — OpenAI Codex CLI: two orthogonal axes (approval policy × sandbox policy)

Codex's defining design choice is that **when to prompt** and **what the OS allows** are **two independent config axes**, composable:

1. **`approval_policy`** (`AskForApproval`, `openai/codex` `codex-rs/protocol/src/protocol.rs:912`, kebab-case serialized) — controls when Codex pauses to ask before executing a command:
   - `untrusted` → `UnlessTrusted` (`protocol.rs:918`): only commands `is_safe_command()` deems safe **and read-only** auto-run; everything else prompts.
   - `on-request` → `OnRequest` (`#[default]`, `protocol.rs:923`): the model decides when to ask; `on-failure` is a serde alias.
   - `granular` → `Granular(GranularApprovalConfig)` (`protocol.rs:931`, struct at `:939`): per-category booleans — `sandbox_approval`, `rules`, `skill_approval`, `request_permissions`, `mcp_elicitations` — where `false` **auto-rejects** that category instead of prompting.
   - `never` (`protocol.rs:935`): never prompt; command failures return straight to the model.
   - Canonical config key (verbatim): `approval_policy: untrusted | on-request | never | { granular = { sandbox_approval = bool, rules = bool, mcp_elicitations = bool, request_permissions = bool, skill_approval = bool } }` — "Controls when Codex pauses for approval before executing commands." ([developers.openai.com/codex/config-reference](https://developers.openai.com/codex/config-reference)).

2. **`sandbox_mode`** (`SandboxPolicy`, `protocol.rs:999`, tagged union) — OS-level **filesystem + network** restriction *during command execution*:
   - `read-only` (`ReadOnly`, `protocol.rs:1006`): read-only FS; outbound **network off by default** (`network_access: bool`, default `false`).
   - `workspace-write` (`WorkspaceWrite`, `protocol.rs:1025`): read-only **plus** write to cwd/workspace (+ extra `writable_roots`) with `exclude_tmpdir_env_var` / `exclude_slash_tmp` knobs.
   - `external-sandbox` (`ExternalSandbox`, `protocol.rs:1016`): the process is *already* sandboxed by an outer harness; Codex honors only the network setting.
   - `danger-full-access` (`DangerFullAccess`, `protocol.rs:1002`): no restrictions.
   - Canonical config key (verbatim): `sandbox_mode: read-only | workspace-write | danger-full-access` — "Sandbox policy for filesystem and network access during command execution." ([config-reference](https://developers.openai.com/codex/config-reference)); built-in permission profiles `:read-only` / `:workspace` / `:danger-full-access`.
   - **Privilege-escalation hardening**: writable roots carry an explicit list of subpaths kept **read-only even under a writable root** — `.codex`, `.git`, **notably `.git/hooks`** — i.e. the very paths that could escalate the agent's privileges are pinned read-only (`protocol.rs:1052`, `WritableRoot` `:1055`). [Sandbox and approvals](https://developers.openai.com/codex/security) is the canonical doc pointer.

**Takeaway.** Codex's answer to "gate the agent" is **defense-in-depth on two independent planes**: an OS-enforced FS/network sandbox (the *backstop*) **and** a per-command approval policy (the *front gate*), with `untrusted`/`read-only` as a safe pairing and `never`/`danger-full-access` as full autonomy. The two are orthogonal — e.g. `on-request` + `workspace-write` prompts only for actions outside the workspace. This is paradigm **(d) OS-level sandbox** (Codex) **plus** paradigm **(a) per-call approval** on the same axis pi's `beforeToolCall` (C-Q2.5) and the Claude SDK's `canUseTool` (part 4) occupy.

### C-Q3.3 — Aider: no gate, no sandbox — version-control-as-safety-net

Aider is the structural opposite of Codex: it has **no OS sandbox and no command-approval gate at all**. Its safety model is *recoverability + opt-in edit control*, not *prevention*:

1. **Every edit is auto-committed** with a descriptive message, so any change is one `/undo` away — "Whenever aider edits a file, it commits those changes with a descriptive commit message… easy to undo or review aider's changes." ([aider.chat/docs/git](https://aider.chat/docs/git.html)). `--no-auto-commits` turns this off.
2. **Dirty-file protection**: before editing a file that already has uncommitted changes, Aider *first* commits the preexisting ("dirty") changes separately, so the user's in-flight work is never tangled with the model's edit; toggle with `--no-dirty-commits`. (Same source.)
3. **Mode-based edit control** (in-session, no shell): `/ask` = answer questions **without editing any files**; `/code` = apply edits; `/architect` = one model proposes, another applies; `/editor` = hand off to `$EDITOR`; `/chat` = free conversation. Commands enumerated at [aider.chat/docs/usage/commands](https://aider.chat/docs/usage/commands.html).
4. **Shell is explicit, never sandboxed**: `/run <cmd>` executes a shell command and shares its output with the model; `/test` runs the configured test command. There is **no pre-execution approval prompt and no FS/network confinement** — the model never invokes shell autonomously; the user types `/run`.

**Takeaway.** Aider's paradigm is: **(i) git as the undo/safety net** (auto-commit + dirty-file isolation), **(ii) edit-mode gating** (`/ask` denies edits structurally), **(iii) explicit user-initiated shell**. It deliberately does **not** gate or sandbox bash — it removes the model's ability to run shell *autonomously* and makes every file change trivially reversible instead. This is a third distinct paradigm — neither Codex's sandbox+approval nor the pi/Claude-SDK per-call hook — and it is the **least transferable** to disclaude's "model can run bash + drive a browser" model: disclaude *wants* autonomous tool use, which Aider structurally avoids.

### Cross-vendor implication (for the eventual C1/C2/C3 call)

Across the now-**three** non-pi-family vendors benchmarked, three distinct paradigms appear — all **in addition to** the two in-family confirmations (`pi-agent-core` `beforeToolCall` C-Q2.5, `pi-coding-agent` CLI C-Q2.6):

| Vendor | Primary gate paradigm | OS sandbox? | Bash front-gate? |
|---|---|---|---|
| Claude Agent SDK (part 4) | programmatic pre-tool-call deny (`canUseTool` / `PreToolUse.permissionDecision`) | no (delegated to embedder) | yes (hook) |
| OpenAI Codex (part 5) | **two-axis**: approval_policy × sandbox_mode | **yes** (read-only / workspace-write / danger) | yes (approval policy) |
| Aider (part 5) | git-undo + edit-modes + explicit `/run` | no | **no** (shell is user-initiated only) |

The **per-call pre-tool approval** paradigm now has **two independent non-family confirmations** (Claude SDK `canUseTool`/`PreToolUse`, Codex `approval_policy`); the **OS-sandbox backstop** has one strong non-family confirmation (Codex `sandbox_mode`, with explicit privilege-escalation hardening on `.git/hooks`). This **modestly reinforces the preliminary lean** from parts 2–4: paradigm **(a) a per-call pre-tool hook as the primary gate** (now four data points: pi×2, Claude SDK, Codex), with **(b)/(c) allowlist/arg-policy as the decision that hook consults**, and **(d) an OS-style sandbox as the defense-in-depth backstop** for bash — exactly Codex's two-axis shape. **It does not finalize C1/C2/C3**: Aider shows a viable-but-different "reversibility over prevention" paradigm the owner may still weigh, and the full cost/invasiveness/bypassability scoring (C-Q4) plus Cursor's data point remain open.

### What part 5 does *not* do (honest scope)

- **Cursor is deferred to part 6.** `docs.cursor.com` is a client-rendered Next.js SPA — every path (incl. `/agent/auto-run`, `/llms-full.txt`) returns the same 489 KB shell with no server-side prose, so it cannot be sourced via HTTP the way Codex (`developers.openai.com` + `openai/codex` source) and Aider (`aider.chat`) can. It is also the **least analogous** vendor (GUI IDE agent, not an in-process TS CLI). Sourcing it would require JS rendering (e.g. a headless browser); deferred rather than asserted from memory.
- **The final C-Q4 cost/invasiveness/bypassability matrix + final C1/C2/C3 recommendation are still not made** (depend on the remaining C-Q3 vendor + an explicit owner call).
- **No claim about which paradigm disclaude *should* adopt** — only evidence gathering + a preliminary-lean update, consistent with parts 3–4.

---

## Threat model (disclaude-owned gating)

> ⚠️ **Part 3 (2026-08-08) revises invariants #2 and #3 below** — see the [Part 3 addendum](#part-3-addendum-2026-08-08-mcp-retired--gating-surface-shrinks-to-inline-only) above. The MCP→pi converter (#4417) is closed won't-do; the only tool injection point on the pi path is now the inline-tool adapter (#4387), and the browser surface migrates to a Playwright Skill (#4460). The framing below is retained as the historical part-1/part-2 reasoning.

The threat model from #4383 §5 / #4389, made concrete by C-Q1+C-Q2:

1. **Sole authority.** With `agentBackend = pi`, pi inherits the launcher's OS permissions and **never prompts, never denies, never logs a permission decision.** Therefore disclaude must be the sole permission authority on the pi path. (On the Claude path the SDK *can* act as authority when `permissionMode='default'`, but disclaude defaults to `bypassPermissions`, so in practice disclaude is also the de-facto authority there — and currently exercises that authority by doing nothing.)

2. **The MCP→pi converter is the critical choke point — it must not become a bypass.** #4417 wraps each MCP tool (Playwright MCP, etc.) into a pi `AgentHarnessTool` and injects it into `agentLoop`. If the converter injects a tool whose `execute` calls `client.callTool(...)` directly, that tool bypasses any gate. **The gating layer must wrap `execute` itself** (or sit at the `ExecutionEnv` level), so that *no tool — inline or MCP-backed — can reach the OS / browser without passing the gate.* This is the single invariant the implementation (#4389) must guarantee.

3. **bash + browser are the two high-risk surfaces.** bash (arbitrary code) and Playwright MCP (drives a browser, can exfiltrate) are the capabilities that motivate gating. Any paradigm chosen in part 2 must demonstrably cover both, not just file ops.

4. **Deny path must be real and tested.** #4389 acceptance item 2 ("a tool call that should be denied *is* denied on the pi path") is the correctness criterion. A gate that only *logs* or *default-allows* does not satisfy it.

---

## Preliminary C-Q4 candidate-paradigm map (evidence-based; final rec in part 2)

> #4432 lists five structural candidates. Mapping each onto the C-Q1/C-Q2 evidence — **without** yet benchmarking against external SDKs (that is C-Q3, part 2):

| Paradigm | Fits pi's actual surface? | disclaude-owned? | Covers bash+browser? | Notes from evidence |
|---|---|---|---|---|
| **(a) pre-tool-call hook (replicate Claude `canUseTool`)** | ✅ **(revised part 2)** pi-agent-core exposes a native `beforeToolCall` deny hook (C-Q2.5) | ✅ | ✅ | Part 1 said "pi has no hook slot" — **corrected**: `beforeToolCall` with `{block:true}` is documented + invoked in-loop (`agent-loop.js:405`). disclaude sets it on the `PiAgent`; covers inline + MCP uniformly. ⚠️ **(part 3)** with MCP dropped (#4417 closed), "inline + MCP" collapses to **inline-only (#4387)** — the single tool path; the hook's coverage claim is unchanged but total. |
| **(b) tool-wrapper强制注入 [C2]** — wrap each tool's `execute` | ✅ disclaude controls injection at #4417/#4387 | ✅ | ✅ | Natural fit: the converter/inline-tool factory already wraps `execute`; inserting a gate there covers **inline + MCP** uniformly (matches threat-model invariant #2). ⚠️ **(part 3)** "injection at #4417/#4387" narrows to **#4387 only** (#4417 closed won't-do); invariant #2's MCP-converter framing is moot — see Part 3 addendum. |
| **(c) deny-all allowlist [C3]** — tool-name + arg policy | ◐ already half-done (tool-name only, `options-adapter.ts:86-177`) | ✅ | ◐ name-level only; arg-level needs (b) | Tightening today's coarse list to deny-by-default is cheap; full arg-level deny needs a wrapper. |
| **(d) OS-level sandbox (container / seccomp / custom `ExecutionEnv`)** | ✅ pi's `ExecutionEnv` = `FileSystem`+`Shell` (`types.d.ts:238`) is the native slot | ✅ (disclaude supplies the env) | ✅ (Shell covers bash; browser needs separate handling) | Strongest "can't be bypassed by a clever tool" option; heaviest to build. Maps to pi's only structural gating surface (C-Q2.3). |
| **(e) capability-scoped tool injection** | ✅ | ✅ | ✅ | A config-driven subset of (b)/(c); composes with them rather than replacing. |

**Preliminary lean (subject to part-2 C-Q3 benchmarking):** the C-Q2.5 correction **promotes (a) to the primary candidate** — disclaude sets `PiAgent.beforeToolCall` and returns `{ block: true, reason }` to deny, natively covering inline + MCP tools (incl. args, via `BeforeToolCallContext.args`) with no converter. (b)/(c) become **policy layers feeding that hook** (the allowlist from `options-adapter.ts` + an arg-level policy become the decision the hook consults), and (d) via a custom `ExecutionEnv` remains the defense-in-depth backstop for bash. pi's own CLI (C-Q2.6) corroborates this: it also builds on `beforeToolCall` + allowlist/trust and does **not** use an OS sandbox. This is **not** the final recommendation — it will be confirmed or revised once C-Q3 benchmarks how Claude Agent SDK / Codex / Aider / Cursor actually implement gating (part 2).

---

## Mapping to #4389 acceptance

| #4389 acceptance item | Status after this part |
|---|---|
| 1. Audit how the Claude backend enforces permissions today | ✅ **Done** (C-Q1 — the audit; key finding: disclaude delegates + defaults to bypass, so "replicate" ≈ "build shared layer") |
| 2. Permission gate fires for pi-path tool calls (inline + MCP) | ⏳ Implementation work (#4389), but **mechanism now concrete (part 2)**: set `PiAgent.beforeToolCall` (C-Q2.5) → disclaude's gate returns `{ block: true, reason }` to deny; fires in-loop before every tool, so inline + MCP (#4417) are both covered. Gated on #4386 (queryStream live). ⚠️ **(part 3)** "inline + MCP (#4417)" → **inline-only (#4387)**; #4417 closed won't-do (MCP dropped). Still gated on #4386 (`provider.ts:74` still `NOT_IMPLEMENTED`). |
| 3. Deny path tested | ⏳ Implementation work (#4389) |
| 4. Threat-model note on the pi docs page (S5) | ◐ This doc is the threat-model source; a one-paragraph distillation still needs to land in `docs/pi-backend.md` as part of #4388/#4389 follow-up |

---

## Acceptance (#4432) — status

- [x] **C-Q1 answered with evidence** (C-Q1.1–C-Q1.5, every claim cites `file:line`).
- [x] **C-Q2 answered with evidence** — re-verified on **0.83.0** (C-Q2.1–C-Q2.4); **C-Q2.2 corrected in part 2** (pi-agent-core *does* expose a `beforeToolCall` deny hook, C-Q2.5) and **C-Q2.6 adds the pi-coding-agent CLI gating model** (closes deferred #3).
- [◐] **C-Q3 — industry-paradigm comparison** (Claude Agent SDK permission hooks / OpenAI Codex sandbox / Aider / Cursor) — **partial (3/4 vendors)**: **Claude Agent SDK** (part 4, C-Q3.1), **OpenAI Codex** sandbox+approval two-axis model (part 5, C-Q3.2, primary Rust source), and **Aider** git-undo/edit-mode model (part 5, C-Q3.3) are answered; plus the pi-family data points (C-Q2.5/C-Q2.6). **Cursor still web-deferred** (SPA-only docs → part 6).
- [◐] **C-Q4 — candidate-paradigm comparison matrix** — *preliminary*, evidence-based map delivered; **final cost/invasiveness/bypassability scoring + final recommendation deferred to part 2** (depends on C-Q3).
- [x] **Threat model written** (disclaude sole authority; tool injection point not bypassable). ⚠️ **(part 3)** revised for the 2026-08-07 MCP-removal decision: the injection point is now inline-only (#4387), not the MCP converter (#4417 closed) — see Part 3 addendum.
- [◐] **Recommendation + #4389 mapping** — preliminary lean + #4389 acceptance map delivered; final C1/C2/C3 selection deferred (depends on C-Q3).
- [x] **Decision drift tracked honestly** — part 3 records that the 2026-08-07 owner decision (pi will not support MCP) supersedes the part-1/part-2 MCP-converter framing; the doc no longer presents a closed issue (#4417) as a live injection point.
- [x] **Uncovered items marked honestly** (this section + "Deferred").

---

## Deferred to part 2 (honest gaps)

1. **C-Q3 — external/industry benchmarking.** How do OpenAI Codex's sandbox, Aider's yes-no/edit, and Cursor's permission flow actually work, and which is the closest analog for "in-process TS agent that must gate bash + browser"? **✅ Codex (C-Q3.2, part 5) and Aider (C-Q3.3, part 5)** are now answered from canonical external docs + primary source; **✅ Claude Agent SDK** in part 4 (C-Q3.1). **Only Cursor remains web-deferred** — its docs are a client-rendered SPA (no server-side prose), deferred to part 6 rather than asserted unsourced.
2. **Final C1/C2/C3 recommendation.** Depends on C-Q3; the preliminary lean ((b)+(c) core, (d) backstop) is offered but not final.
3. **`pi-coding-agent` CLI behavior.** ✅ **Done in part 2** (C-Q2.6): audited `@earendil-works/pi-coding-agent@0.83.0` — project-trust + tool allowlist/denylist + extension `beforeToolCall` bridge + TUI-only confirm; no OS sandbox. It is out of disclaude's in-process scope (disclaude embeds `pi-agent-core`, not the CLI), but it confirms the `beforeToolCall` hook (C-Q2.5) is the surface pi's own tooling builds on.
4. **Arg-level policy semantics.** ✅ **Answered in part 2**: feasible at the gate layer — `BeforeToolCallContext.args` (`types.d.ts:75-76`) exposes the **schema-validated arguments**, so a `beforeToolCall` gate can inspect a specific bash command / URL, not just the tool name. Whether to *require* arg-level inspection is still a #4389 design choice, but the capability is present.

---

## Evidence provenance

- Repo: `hs3180/disclaude` @ `3902efd` (main HEAD at part-1 research time); part-2 additions re-checked against HEAD `e723b8d` (`PiAgentProvider.queryStream` still `NOT_IMPLEMENTED`).
- pi tarballs: `@earendil-works/pi-agent-core@0.83.0` (part 1 + part 2; grepped `package/dist`); `@earendil-works/pi-coding-agent@0.83.0` (part 2, C-Q2.6; `npm pack`, grepped `package/dist`).
- Part 3 (2026-08-08) adds no new code/tarball claims; it records a decision and re-points existing claims to current main. Sources: owner decision comment [hs3180/disclaude#4383 (comment 5208309432)](https://github.com/hs3180/disclaude/issues/4383#issuecomment-5208309432) (2026-08-07); issue states re-verified via the GitHub API on 2026-08-08 — #4417 `closed`/`not_planned`, #4387 open (adapter at `packages/core/src/sdk/providers/pi/inline-tool-adapter.ts:158`), #4386 open (`provider.ts:74` still `NOT_IMPLEMENTED`); #4459 / #4460 open (Skills migration).
- Part 4 (2026-08-13) inspects the installed `@anthropic-ai/claude-agent-sdk@0.3.177` tarball (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` of a repo install; version pinned at `packages/core/package.json:19`) — `CanUseTool` `:186-230`, `canUseTool` Options field `:1349`, `PermissionResult` `:2075`, `hooks`/`HookEvent`/`HookPermissionDecision` `:1490`/`:821`/`:827`, `PreToolUseHookSpecificOutput.permissionDecision` `:2216-2218`, PreToolUse-bypasses-canUseTool JSDoc `:3758`, `PermissionMode` `:2053`. disclaude-side claims re-verified against current main: `options-adapter.ts:31-60`, `sdk/types.ts:226`, `base-agent.ts:136`, and `grep canUseTool|PreToolUse|hooks packages/core/src/sdk/providers/claude/` → 0 hits.
- No web sources were used for any part; every claim is traceable to a file:line or a linked GitHub source above.
- **Part 5 (2026-08-14)** answers C-Q3.2 (OpenAI Codex) + C-Q3.3 (Aider) from **external web sources** (all fetched & HTTP 200 on 2026-08-14) — the first part to use web: primary Rust source `openai/codex` `codex-rs/protocol/src/protocol.rs` (`AskForApproval` `:912-935`, `GranularApprovalConfig` `:939`, `SandboxPolicy` `:999-1047`, `.git/hooks` privilege-escalation hardening `:1052` / `WritableRoot` `:1055`); OpenAI developer docs [config-reference](https://developers.openai.com/codex/config-reference) + [sandbox & approvals](https://developers.openai.com/codex/security); Aider canonical docs [aider.chat/docs/git](https://aider.chat/docs/git.html) + [aider.chat/docs/usage/commands](https://aider.chat/docs/usage/commands.html). Enum/config values are quoted **verbatim** from those sources. Cursor deferred: `docs.cursor.com` returns a 489 KB Next.js SPA shell for every path (incl. `/agent/auto-run`, `/llms-full.txt`) — no server-side prose — so it is deferred to part 6 rather than asserted from memory.
