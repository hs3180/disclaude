# Permission Gating Paradigm for the pi Backend — Research (#4432)

> Serves #4383 decision **(c) permission gating**. Parent: #4383. Implementation issue: #4389.
> **This is part 1** — it delivers **C-Q1 (Claude gating baseline audit)** + **C-Q2 (pi-ecosystem permission status, re-verified on `pi-agent-core@0.83.0`)** + the **threat model** + a **preliminary candidate-paradigm map**. **C-Q3 (industry-paradigm benchmarking — Codex / Aider / Cursor / Claude Agent SDK hooks) and the final C1/C2/C3 recommendation are deferred to part 2** (they require web research against external SDK docs; this part stays strictly grounded in the repo + the installed pi tarball, no speculation).

---

## TL;DR

1. **disclaude does not itself enforce tool permissions today — not on the Claude path, and (a fortiori) not on the pi path.** The Claude backend *delegates* the entire permission contract to the Claude Agent SDK subprocess via three options (`permissionMode` / `allowedTools`+`disallowedTools` / `settingSources`), and `IAgentSDKProvider` exposes **no permission surface at all**. There is no `canUseTool` / pre-tool-call hook anywhere in `packages/core` or `packages/primary-node`.
2. **The default permission mode is `bypassPermissions`** (`base-agent.ts:136`). So "the Claude backend gates tools" is, in practice, "the SDK is *configured* to gate, and disclaude asks it not to." This re-frames #4389's premise ("audit how Claude enforces, replicate on pi"): there is little disclaude-owned enforcement to replicate — the real task is to **build** a gating layer that both backends can share.
3. **`pi-agent-core@0.83.0` (newer than the spike's 0.82.1) still has no permission / approval / allowlist / pre-tool-call system.** ⚠️ **(part 2 corrected this — see C-Q2.5: pi-agent-core *does* expose an unlabeled `beforeToolCall` deny hook; the "no pre-tool-call" wording below is superseded for that one point.)** The only `permission` token in the whole package is a `FileErrorCode = "permission_denied"` enum value (POSIX-style error, not a gate). What pi *does* expose is a pluggable **`FileSystem` + `Shell`** environment (`ExecutionEnv`) — the natural injection point for OS-level / sandbox-style gating.
4. The pi provider skeleton already implements a **coarse tool-name allowlist** (`allowedTools` − `disallowedTools` → pi's active-tool set), and explicitly defers runtime gating to #4389 (`providers/pi/options-adapter.ts:39`). So today the pi path has tool-*enumeration* filtering but **no per-call permission decision**.
5. **Threat-model bottom line:** with `agentBackend = pi`, **disclaude is the sole permission authority** (pi inherits the launcher's perms and never asks). Any gating must live in disclaude-owned code that **every** tool invocation routes through — in particular the MCP→pi converter injection point (#4417) must not become a bypass.

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

## Threat model (disclaude-owned gating)

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
| **(a) pre-tool-call hook (replicate Claude `canUseTool`)** | ✅ **(revised part 2)** pi-agent-core exposes a native `beforeToolCall` deny hook (C-Q2.5) | ✅ | ✅ | Part 1 said "pi has no hook slot" — **corrected**: `beforeToolCall` with `{block:true}` is documented + invoked in-loop (`agent-loop.js:405`). disclaude sets it on the `PiAgent`; covers inline + MCP uniformly. |
| **(b) tool-wrapper强制注入 [C2]** — wrap each tool's `execute` | ✅ disclaude controls injection at #4417/#4387 | ✅ | ✅ | Natural fit: the converter/inline-tool factory already wraps `execute`; inserting a gate there covers **inline + MCP** uniformly (matches threat-model invariant #2). |
| **(c) deny-all allowlist [C3]** — tool-name + arg policy | ◐ already half-done (tool-name only, `options-adapter.ts:86-177`) | ✅ | ◐ name-level only; arg-level needs (b) | Tightening today's coarse list to deny-by-default is cheap; full arg-level deny needs a wrapper. |
| **(d) OS-level sandbox (container / seccomp / custom `ExecutionEnv`)** | ✅ pi's `ExecutionEnv` = `FileSystem`+`Shell` (`types.d.ts:238`) is the native slot | ✅ (disclaude supplies the env) | ✅ (Shell covers bash; browser needs separate handling) | Strongest "can't be bypassed by a clever tool" option; heaviest to build. Maps to pi's only structural gating surface (C-Q2.3). |
| **(e) capability-scoped tool injection** | ✅ | ✅ | ✅ | A config-driven subset of (b)/(c); composes with them rather than replacing. |

**Preliminary lean (subject to part-2 C-Q3 benchmarking):** the C-Q2.5 correction **promotes (a) to the primary candidate** — disclaude sets `PiAgent.beforeToolCall` and returns `{ block: true, reason }` to deny, natively covering inline + MCP tools (incl. args, via `BeforeToolCallContext.args`) with no converter. (b)/(c) become **policy layers feeding that hook** (the allowlist from `options-adapter.ts` + an arg-level policy become the decision the hook consults), and (d) via a custom `ExecutionEnv` remains the defense-in-depth backstop for bash. pi's own CLI (C-Q2.6) corroborates this: it also builds on `beforeToolCall` + allowlist/trust and does **not** use an OS sandbox. This is **not** the final recommendation — it will be confirmed or revised once C-Q3 benchmarks how Claude Agent SDK / Codex / Aider / Cursor actually implement gating (part 2).

---

## Mapping to #4389 acceptance

| #4389 acceptance item | Status after this part |
|---|---|
| 1. Audit how the Claude backend enforces permissions today | ✅ **Done** (C-Q1 — the audit; key finding: disclaude delegates + defaults to bypass, so "replicate" ≈ "build shared layer") |
| 2. Permission gate fires for pi-path tool calls (inline + MCP) | ⏳ Implementation work (#4389), but **mechanism now concrete (part 2)**: set `PiAgent.beforeToolCall` (C-Q2.5) → disclaude's gate returns `{ block: true, reason }` to deny; fires in-loop before every tool, so inline + MCP (#4417) are both covered. Gated on #4386 (queryStream live). |
| 3. Deny path tested | ⏳ Implementation work (#4389) |
| 4. Threat-model note on the pi docs page (S5) | ◐ This doc is the threat-model source; a one-paragraph distillation still needs to land in `docs/pi-backend.md` as part of #4388/#4389 follow-up |

---

## Acceptance (#4432) — status

- [x] **C-Q1 answered with evidence** (C-Q1.1–C-Q1.5, every claim cites `file:line`).
- [x] **C-Q2 answered with evidence** — re-verified on **0.83.0** (C-Q2.1–C-Q2.4); **C-Q2.2 corrected in part 2** (pi-agent-core *does* expose a `beforeToolCall` deny hook, C-Q2.5) and **C-Q2.6 adds the pi-coding-agent CLI gating model** (closes deferred #3).
- [ ] **C-Q3 — industry-paradigm comparison** (Claude Agent SDK permission hooks / OpenAI Codex sandbox / Aider / Cursor) — **still deferred** (requires web research against external SDK docs). Part 2 added one **ecosystem** data point (pi-coding-agent CLI, C-Q2.6), but that is the same pi family, not an independent cross-vendor benchmark.
- [◐] **C-Q4 — candidate-paradigm comparison matrix** — *preliminary*, evidence-based map delivered; **final cost/invasiveness/bypassability scoring + final recommendation deferred to part 2** (depends on C-Q3).
- [x] **Threat model written** (disclaude sole authority; MCP injection point not bypassable).
- [◐] **Recommendation + #4389 mapping** — preliminary lean + #4389 acceptance map delivered; final C1/C2/C3 selection deferred to part 2.
- [x] **Uncovered items marked honestly** (this section + "Deferred to part 2").

---

## Deferred to part 2 (honest gaps)

1. **C-Q3 — external/industry benchmarking.** How do Claude Agent SDK's `canUseTool`/permission hooks, OpenAI Codex's sandbox, Aider's yes-no/edit, and Cursor's permission flow actually work, and which is the closest analog for "in-process TS agent that must gate bash + browser"? This needs reading external SDK docs (web) and was **not** attempted here to avoid unsourced claims.
2. **Final C1/C2/C3 recommendation.** Depends on C-Q3; the preliminary lean ((b)+(c) core, (d) backstop) is offered but not final.
3. **`pi-coding-agent` CLI behavior.** ✅ **Done in part 2** (C-Q2.6): audited `@earendil-works/pi-coding-agent@0.83.0` — project-trust + tool allowlist/denylist + extension `beforeToolCall` bridge + TUI-only confirm; no OS sandbox. It is out of disclaude's in-process scope (disclaude embeds `pi-agent-core`, not the CLI), but it confirms the `beforeToolCall` hook (C-Q2.5) is the surface pi's own tooling builds on.
4. **Arg-level policy semantics.** ✅ **Answered in part 2**: feasible at the gate layer — `BeforeToolCallContext.args` (`types.d.ts:75-76`) exposes the **schema-validated arguments**, so a `beforeToolCall` gate can inspect a specific bash command / URL, not just the tool name. Whether to *require* arg-level inspection is still a #4389 design choice, but the capability is present.

---

## Evidence provenance

- Repo: `hs3180/disclaude` @ `3902efd` (main HEAD at part-1 research time); part-2 additions re-checked against HEAD `e723b8d` (`PiAgentProvider.queryStream` still `NOT_IMPLEMENTED`).
- pi tarballs: `@earendil-works/pi-agent-core@0.83.0` (part 1 + part 2; grepped `package/dist`); `@earendil-works/pi-coding-agent@0.83.0` (part 2, C-Q2.6; `npm pack`, grepped `package/dist`).
- No web sources were used for either part; every claim is traceable to a file:line above.
