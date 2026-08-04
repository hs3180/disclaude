# Permission Gating Paradigm for the pi Backend — Research (#4432)

> Serves #4383 decision **(c) permission gating**. Parent: #4383. Implementation issue: #4389.
> **This is part 1** — it delivers **C-Q1 (Claude gating baseline audit)** + **C-Q2 (pi-ecosystem permission status, re-verified on `pi-agent-core@0.83.0`)** + the **threat model** + a **preliminary candidate-paradigm map**. **C-Q3 (industry-paradigm benchmarking — Codex / Aider / Cursor / Claude Agent SDK hooks) and the final C1/C2/C3 recommendation are deferred to part 2** (they require web research against external SDK docs; this part stays strictly grounded in the repo + the installed pi tarball, no speculation).

---

## TL;DR

1. **disclaude does not itself enforce tool permissions today — not on the Claude path, and (a fortiori) not on the pi path.** The Claude backend *delegates* the entire permission contract to the Claude Agent SDK subprocess via three options (`permissionMode` / `allowedTools`+`disallowedTools` / `settingSources`), and `IAgentSDKProvider` exposes **no permission surface at all**. There is no `canUseTool` / pre-tool-call hook anywhere in `packages/core` or `packages/primary-node`.
2. **The default permission mode is `bypassPermissions`** (`base-agent.ts:136`). So "the Claude backend gates tools" is, in practice, "the SDK is *configured* to gate, and disclaude asks it not to." This re-frames #4389's premise ("audit how Claude enforces, replicate on pi"): there is little disclaude-owned enforcement to replicate — the real task is to **build** a gating layer that both backends can share.
3. **`pi-agent-core@0.83.0` (newer than the spike's 0.82.1) still has no permission / approval / allowlist / pre-tool-call system.** The only `permission` token in the whole package is a `FileErrorCode = "permission_denied"` enum value (POSIX-style error, not a gate). What pi *does* expose is a pluggable **`FileSystem` + `Shell`** environment (`ExecutionEnv`) — the natural injection point for OS-level / sandbox-style gating.
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

### C-Q2.2 No permission/approval/allowlist/pre-tool-call system

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
| **(a) pre-tool-call hook (replicate Claude `canUseTool`)** | ⚠️ pi has no hook slot — must be realized as (b) | ✅ | ✅ | Claude itself does this *inside the SDK*; disclaude has no hook today (C-Q1.2). On pi it can only exist as a wrapper. |
| **(b) tool-wrapper强制注入 [C2]** — wrap each tool's `execute` | ✅ disclaude controls injection at #4417/#4387 | ✅ | ✅ | Natural fit: the converter/inline-tool factory already wraps `execute`; inserting a gate there covers **inline + MCP** uniformly (matches threat-model invariant #2). |
| **(c) deny-all allowlist [C3]** — tool-name + arg policy | ◐ already half-done (tool-name only, `options-adapter.ts:86-177`) | ✅ | ◐ name-level only; arg-level needs (b) | Tightening today's coarse list to deny-by-default is cheap; full arg-level deny needs a wrapper. |
| **(d) OS-level sandbox (container / seccomp / custom `ExecutionEnv`)** | ✅ pi's `ExecutionEnv` = `FileSystem`+`Shell` (`types.d.ts:238`) is the native slot | ✅ (disclaude supplies the env) | ✅ (Shell covers bash; browser needs separate handling) | Strongest "can't be bypassed by a clever tool" option; heaviest to build. Maps to pi's only structural gating surface (C-Q2.3). |
| **(e) capability-scoped tool injection** | ✅ | ✅ | ✅ | A config-driven subset of (b)/(c); composes with them rather than replacing. |

**Preliminary lean (subject to part-2 C-Q3 benchmarking):** the evidence points toward **(b) + (c)** as the pragmatic core (uniform inline+MCP coverage at the injection point disclaude already owns, building on the allowlist that already exists), with **(d)** via a custom `ExecutionEnv` as the defense-in-depth backstop for bash. This is **not** the final recommendation — it will be confirmed or revised once C-Q3 benchmarks how Claude Agent SDK / Codex / Aider / Cursor actually implement gating (part 2).

---

## Mapping to #4389 acceptance

| #4389 acceptance item | Status after this part |
|---|---|
| 1. Audit how the Claude backend enforces permissions today | ✅ **Done** (C-Q1 — the audit; key finding: disclaude delegates + defaults to bypass, so "replicate" ≈ "build shared layer") |
| 2. Permission gate fires for pi-path tool calls (inline + MCP) | ⏳ Implementation work (#4389); design informed by threat-model invariant #2 |
| 3. Deny path tested | ⏳ Implementation work (#4389) |
| 4. Threat-model note on the pi docs page (S5) | ◐ This doc is the threat-model source; a one-paragraph distillation still needs to land in `docs/pi-backend.md` as part of #4388/#4389 follow-up |

---

## Acceptance (#4432) — status

- [x] **C-Q1 answered with evidence** (C-Q1.1–C-Q1.5, every claim cites `file:line`).
- [x] **C-Q2 answered with evidence** — re-verified on **0.83.0**, not just the spike's 0.82.1 (C-Q2.1–C-Q2.4).
- [ ] **C-Q3 — industry-paradigm comparison** (Claude Agent SDK permission hooks / OpenAI Codex sandbox / Aider / Cursor) — **deferred to part 2** (requires web research against external SDK docs; intentionally not speculated here).
- [◐] **C-Q4 — candidate-paradigm comparison matrix** — *preliminary*, evidence-based map delivered; **final cost/invasiveness/bypassability scoring + final recommendation deferred to part 2** (depends on C-Q3).
- [x] **Threat model written** (disclaude sole authority; MCP injection point not bypassable).
- [◐] **Recommendation + #4389 mapping** — preliminary lean + #4389 acceptance map delivered; final C1/C2/C3 selection deferred to part 2.
- [x] **Uncovered items marked honestly** (this section + "Deferred to part 2").

---

## Deferred to part 2 (honest gaps)

1. **C-Q3 — external/industry benchmarking.** How do Claude Agent SDK's `canUseTool`/permission hooks, OpenAI Codex's sandbox, Aider's yes-no/edit, and Cursor's permission flow actually work, and which is the closest analog for "in-process TS agent that must gate bash + browser"? This needs reading external SDK docs (web) and was **not** attempted here to avoid unsourced claims.
2. **Final C1/C2/C3 recommendation.** Depends on C-Q3; the preliminary lean ((b)+(c) core, (d) backstop) is offered but not final.
3. **`pi-coding-agent` CLI behavior.** C-Q2 focused on `pi-agent-core` (the package disclaude will embed, per the 2026-07-28 decision). The `pi-coding-agent` CLI's own gating (if any) was not audited; it is out of disclaude's in-process scope but is noted for completeness.
4. **Arg-level policy semantics.** Whether the gate must inspect tool *arguments* (e.g. a specific bash command) vs. only tool *names* is a design decision for #4389, not a research finding; flagged here so it is not forgotten.

---

## Evidence provenance

- Repo: `hs3180/disclaude` @ `3902efd` (main HEAD at research time).
- pi tarball: `@earendil-works/pi-agent-core@0.83.0` (`npm pack`, grepped `package/dist`).
- No web sources were used for this part; every claim is traceable to a file:line above.
