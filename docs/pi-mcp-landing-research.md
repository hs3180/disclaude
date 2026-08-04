# MCP Landing Path for the pi Backend — Research (#4431, part 1)

> Parent: **#4383** · Serves decision **(b) MCP path** (choose between B1/B2/B3) ·
> Type: research / feasibility (decision-gating).
>
> **This is part 1 of [#4431](https://github.com/hs3180/disclaude/issues/4431).**
> Part 1 answers the four research questions **B-Q1..B-Q4 with codebase + upstream-tarball evidence**.
> The **Playwright-MCP end-to-end PoC** and the **upstream release-notes / discussion web
> survey** are explicitly deferred to **part 2** (see §"Deferred to part 2"). Every claim below
> cites a `file:line`; there are **zero web sources** in part 1 (the pi version facts come from
> `npm view` + installed tarballs, not the website).

Companion docs:

- `docs/pi-agent-core-api-research.md` — the #4384 spike. It established (against
  `pi-agent-core@0.82.1`) that MCP is **not** natively consumed and that the tool format is
  TypeBox + a 5-param `execute`. This doc **re-surveys upstream at 0.83.0** (the spike "stopped at
  0.82.1", `pi/options-adapter.ts:18-20`) and works out the converter plan the spike deferred.

---

## TL;DR

| Q | Answer (evidence-backed) |
|---|---|
| **B-Q1** Did upstream add MCP after 0.82.1? | **No.** `pi-agent-core`, `pi-ai`, `pi-coding-agent` **all @0.83.0** have **0** `mcp` symbols in `dist/**/*.d.ts`. "Wait for upstream" (a B1.5 option) is **not viable as of 0.83.0**. |
| **B-Q2** Is the MCP→`AgentHarnessTool` converter feasible? | **Yes, and lighter than the spike implied.** `AgentHarnessTool` = TypeBox `TParameters` + 5-param `execute`. pi uses `typebox@1.3.7` (unscoped, same author as `@sinclair/typebox`); TypeBox schemas **are JSON-Schema**, so an MCP `inputSchema` maps near-free. `@modelcontextprotocol/sdk@1.29.0` is already in disclaude's lockfile. |
| **B-Q3** Is there a lighter bridge than per-tool wrapping? | **No shortcut, but a clean injection point exists.** `AgentHarness.setTools(tools, activeToolNames?)` (agent-harness.d.ts:76) is the dynamic tool registry — wrap each MCP tool, then `setTools`. Zero MCP-specific plugin/registry symbols exist. |
| **B-Q4** Which MCP servers must the converter cover? | **Two classes.** (a) `channel-mcp` — **inline, in-process** (`send_text`/`send_card`/`send_interactive`/`send_file` + `push-to-agent` + loop tools); (b) **Playwright MCP + any user-configured stdio server** (`disclaude.config.example.yaml:249`). Class (a) overlaps the inline-tool work in #4387; class (b) needs the MCP client converter. |

**Recommendation (conditional, pending the part-2 PoC):** pursue **B1** (write the converter, #4417).
It is the only option that preserves feature parity (Playwright + custom MCP servers). The single
unverified risk is whether pi's TypeBox schema engine needs TypeBox `Kind` symbols on a passthrough
JSON-Schema (§B-Q2 risk R1); the part-2 PoC exists to confirm exactly this. If R1 bites hard, fall
back to **B3 now → B1 later** (ship text + inline tools, mark MCP `degraded`). **B2** (drop MCP,
inline-only) is a permanent capability regression and is not recommended unless the PoC proves the
converter infeasible.

---

## Method (part 1)

Pure local evidence — no networked LLM/PoC runs:

- `npm view @earendil-works/pi-agent-core version` → `0.83.0` (newer than the spike's 0.82.1).
- `npm install` of `pi-agent-core@0.83.0`, `pi-ai@0.83.0`, `pi-coding-agent@0.83.0` into a throwaway
  dir; `grep -rniE 'mcp' dist --include='*.d.ts'` over each.
- Read of the pi `dist/**/*.d.ts` surface (`AgentHarness`, `AgentTool`, `AgentHarnessTool`,
  `AgentToolResult`, `AgentContext`, `AgentLoopConfig.convertToLlm`) and of `typebox@1.3.7`'s
  `schema` / `value` modules.
- `grep` of disclaude main HEAD (`packages/`, `disclaude.config.example.yaml`, `package-lock.json`)
  for MCP consumer wiring + the existing pi-adapter hook.

Part-1 scope is the evidence above. The **PoC** (actually drive Playwright MCP through the
converter) and the **upstream roadmap / release-notes web check** are part 2 — see §"Deferred".

---

## B-Q1 — Upstream MCP evolution since 0.82.1

**Question:** did `pi-agent-core` (and the `pi-ai` / `pi-coding-agent` layers) add MCP after 0.82.1,
and is "wait for upstream" viable?

**Evidence (0.83.0, the current latest):**

```
$ npm view @earendil-works/pi-agent-core version
0.83.0
```

Installed `@earendil-works/{pi-agent-core,pi-ai,pi-coding-agent}@0.83.0` and grepped each `dist`:

| package @ version | `grep -rniE 'mcp' dist --include='*.d.ts'` hits |
|---|---|
| `pi-agent-core@0.83.0` | **0** (also 0 across all of `dist`, any extension) |
| `pi-ai@0.83.0` | **0** |
| `pi-coding-agent@0.83.0` | **0** |

**Conclusion:** the entire pi stack at 0.83.0 still has **no MCP client/server symbols in its
public TypeScript surface** (`dist/**/*.d.ts`) — parity with the 0.82.1 finding in
`docs/pi-agent-core-api-research.md` §1. Upstream added no MCP between 0.82.1 and 0.83.0.

> Scope note: a non-`.d.ts` grep is *not* uniformly zero — `pi-ai` carries an Anthropic OAuth scope
> string `user:mcp_servers` (`dist/auth/oauth/anthropic.js`, an auth constant, not an MCP client),
> and `pi-coding-agent` bundles its `node_modules` deps which contain MCP references. Neither is a
> pi-authored MCP client/server, and neither is in the API surface disclaude integrates against
> (`pi-agent-core`, which is 0 across **all** files). The `.d.ts`-surface finding above is what
> governs the converter decision.

**Implication for the decision:** a "B1.5 — wait for upstream MCP" option is **not viable as of
0.83.0**; there is no visible upstream MCP track to wait on. (Whether the author has *planned* MCP
is a release-notes / discussion question — deferred to part 2; it does not change the 0.83.0
*code* fact.) Therefore any MCP landing on the pi backend in a useful timeframe is disclaude's own
converter (B1) or an explicit capability cut (B2/B3).

> Version caveat (carried from the spike, `pi/options-adapter.ts:18-20`): pi is 0.x / pre-1.0 and
> iterates fast; re-run this grep on any pi bump. The disclaude pin today is still 0.82.1
> (`pi/options-adapter.ts:16-17`); 0.83.0 is the *latest observed*, not yet pinned.

---

## B-Q2 — MCP→`AgentHarnessTool` converter: feasibility, surface, risks

**Question:** what is the real engineering cost and what are the risk points of the converter?

### B-Q2.1 Target shape — `AgentHarnessTool`

From `pi-agent-core@0.83.0` (tarball; line numbers are the package's own `dist`):

```ts
// dist/types.d.ts:333-342
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  label: string;                                   // required — human-readable
  prepareArguments?: (args: unknown) => Static<TParameters>;  // optional raw-arg shim
  execute: (toolCallId: string, params: Static<TParameters>,
            signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<TDetails>)
           => Promise<AgentToolResult<TDetails>>;
  executionMode?: ToolExecutionMode;               // "sequential" | "parallel"
}

// dist/harness/types.d.ts:58-62  — the harness re-declares execute with a 5th `context` param
export type AgentHarnessTool<TContext, TParameters extends TSchema = TSchema, TDetails = unknown> =
  Omit<AgentTool<TParameters, TDetails>, "execute"> & {
    execute(toolCallId: string, params: Static<TParameters>,
            signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
            context: TContext): Promise<AgentToolResult<TDetails>>;
  };
```

```ts
// dist/types.d.ts:310-326 — what execute must return
export interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];   // returned to the model
  details: T;                                 // arbitrary structured details
  usage?: Usage;
  addedToolNames?: string[];
  terminate?: boolean;
}
```

So each MCP tool must become an object with: a TypeBox `parameters` schema, a required `label`, a
required `description` (inherited from `Tool`), and a 5-param `execute` that returns
`AgentToolResult`. This is **exactly the 5-param `execute` the spike flagged**
(`docs/pi-agent-core-api-research.md` §3) — no surprise.

### B-Q2.2 The schema-translation sub-problem (the crux the spike left open)

The spike named `@sinclair/typebox/value` and `typebox-to-json-schema` as candidate libs
(`docs/pi-agent-core-api-research.md` §3). **The landscape has shifted:** pi 0.83.0 does **not**
depend on `@sinclair/typebox`; it depends on the **unscoped `typebox@1.3.7`** (same author —
`sinclairzx81`; "Json Schema Type Builder with Static Type Resolution for TypeScript"):

```
$ node -p "require('pi-agent-core/package.json').dependencies.typebox"
1.3.7
```

```ts
// pi imports the schema primitives from the unscoped package:
// dist/harness/types.d.ts:2
import type { Static, TSchema } from "typebox";
// dist/harness/tools/bash.d.ts:1
import { type Static, Type } from "typebox";
```

`typebox@1.3.7` is modular (`package.json` exports: `./schema`, `./value`, `./type`, `./compile`,
…). Two facts make the translation **much cheaper than a generic JSON-Schema→TypeBox rebuild**:

1. **TypeBox schemas *are* JSON-Schema.** The schema engine's own source marks its output path as
   `// jsonschema` (`typebox/build/schema/engine/type.mjs:8,27`). A `TSchema` object is a
   JSON-Schema object with extra TypeBox `Kind` symbols on each node.
2. **Runtime value ops exist out of the box** for validation/coercion against any schema — the
   `value` module re-exports `check / clean / convert / default / cast / decode / …`
   (`typebox/build/value/index.d.mts:1-19`).

=> An MCP tool's `inputSchema` (already JSON-Schema, per the MCP spec) can be used as the
`parameters` **either** (a) passed through almost verbatim as a `TSchema`-shaped object, **or**
(b) shallowly rebuilt via `Type.*` to stamp TypeBox `Kind` symbols. Runtime arg validation then
uses `Value.Cast` / `Value.Clean` / the engine's `check`. **No third-party `json-schema-to-typebox`
dependency is required** (and the existing packages of that name target the older
`@sinclair/typebox` 0.x, not `typebox` 1.x, so they would be the wrong dependency anyway).

### B-Q2.3 The execute-wrapping sub-problem

`@modelcontextprotocol/sdk@1.29.0` is **already in disclaude's dependency tree** (used by
`@disclaude/mcp-server`):

```
$ grep -A1 '"node_modules/@modelcontextprotocol/sdk"' package-lock.json
    "node_modules/@modelcontextprotocol/sdk": {
      "version": "1.29.0",
```

So the converter can import `Client` + `StdioClientTransport` (for Playwright / user stdio servers)
and, for the inline `channel-mcp`, call its handlers in-process. The per-tool `execute` becomes:

```
execute(toolCallId, params, signal, onUpdate, ctx):
  result = await mcpClient.callTool({ name: mcpToolName, arguments: params }, undefined, { signal })
  return { content: mapMcpResultToTextOrImage(result.content), details: result }
```

`AgentToolResult.content` is `(TextContent | ImageContent)[]` (`types.d.ts:311`) — MCP tool results
are also a content-block array (`{ type: 'text', text } | { type: 'image', data, mimeType } | …`),
so the mapping is structural, not semantic. `label` (required, `types.d.ts:336`) is synthesized from
the MCP tool `name`/`description`.

### B-Q2.4 Registration + LLM-facing encoding

The converted tools plug in via the harness registry (see B-Q3): `harness.setTools([...converted])`.
How pi then presents them to the LLM is governed by `AgentLoopConfig.convertToLlm`
(`dist/types.d.ts:145` — `(messages: AgentMessage[]) => Message[]`), which is the same hook
disclaude's pi options-adapter already knows it must supply (`pi/options-adapter.ts:25` describes
`convertToLlm` as part of pi's `AgentLoopConfig`; the per-run wiring is deferred to provider.ts
part-3, alongside the `mcpServers` converter at `pi/options-adapter.ts:38`). The converter does
**not**
need to know how schemas reach the wire — only that it hands pi well-formed TypeBox-shaped
`parameters`.

### B-Q2.5 Risk register (the real "unknowns")

| ID | Risk | Why it matters | Mitigation / where resolved |
|---|---|---|---|
| **R1** | pi's TypeBox **compiler/checker** may rely on TypeBox `Kind` symbols that a passthrough JSON-Schema lacks, so `Value.Cast`/engine `check` could misbehave on MCP schemas. | This is the one thing the spike could not answer and part 1 cannot answer from `.d.ts` alone. | **Part-2 PoC**: drive one Playwright MCP tool end-to-end. If it bites, fall back to the shallow `Type.*` rebuild (B-Q2.2 option b). |
| **R2** | MCP result content shapes pi doesn't expect (e.g. embedded resource links) → `AgentToolResult.content` mapping gaps. | Tool output silently truncated. | Map only `text`/`image` first (the union pi accepts), stringify the rest; expand in PoC. |
| **R3** | `label` synthesis + tool-name collisions/namespace (`channel-mcp.send_text` vs a stdio tool named `send_text`). | Wrong tool dispatched. | Namespace converted names by server (`<server>__<tool>`); keep MCP `name` for `callTool`. |
| **R4** | Streaming progress: MCP tools don't emit pi-style partials, so `onUpdate` is unused — fine, but large tool outputs won't stream. | UX regression for big Playwright dumps. | Acceptable; document. |
| **R5** | Lifecycle: stdio MCP clients (Playwright) must be started/stopped with the agent; inline `channel-mcp` must be closed (`mcp-setup.ts:99`, the `collectInlineMcpInstances` closeable pattern). | Resource leak / dangling chrome. | Reuse `buildMcpServers`/`collectInlineMcpInstances` lifecycle hooks (B-Q4). |

**Effort estimate** (rough, for sizing B1 against B2/B3; not a commitment): the schema-translation
+ execute-wrap is small (the MCP SDK + TypeBox do the heavy lifting). The cost is dominated by
**lifecycle wiring (R5)** + the **PoC/iteration on R1**. Net: a focused PR series, not a
multi-week effort — *conditional on R1 not forcing a full JSON-Schema→TypeBox rebuild*.

---

## B-Q3 — Is there a lighter bridge than per-tool wrapping?

**Question:** does pi expose a runtime tool registry / plugin / dynamic-add mechanism that would
avoid wrapping each MCP tool individually?

**Evidence:** the `AgentHarness` class (`pi-agent-core/dist/harness/agent-harness.d.ts:4`) exposes
explicit dynamic tool management:

```ts
// dist/harness/agent-harness.d.ts:76,78
setTools(tools: TTool[], activeToolNames?: string[]): Promise<void>;
setActiveTools(toolNames: string[]): Promise<void>;
```

and tools may be supplied at construction too:

```ts
// dist/harness/types.d.ts:656  (AgentHarnessOptionsBase.tools)
tools?: TTool[];
// dist/types.d.ts:359  (AgentContext.tools — per-run)
tools?: AgentTool<any>[];
```

**Conclusion:** there is **no MCP-specific plugin/registry** (zero MCP symbols — B-Q1), but there
*is* a first-class generic tool registry: `setTools([...])`. Per-tool wrapping (MCP tool →
`AgentHarnessTool`) followed by `setTools` **is** the native bridge — there is no lighter
"MCP-aware" shortcut to find. (For reference, how converted tool schemas reach the LLM is
`AgentLoopConfig.convertToLlm`, `dist/types.d.ts:145` — orthogonal to injection.)

So B-Q3's hoped-for "more native than per-tool wrapping" mechanism **does not exist**; B1's design
(wrap + `setTools`) is already the idiomatic path.

---

## B-Q4 — Which MCP servers does disclaude actually consume? (converter coverage)

`buildMcpServers()` (`packages/primary-node/src/agents/mcp-setup.ts:33-75`) produces two classes of
MCP servers, and the config layer (`packages/core/src/config/index.ts:521-523`,
`Config.getMcpServersConfig()`) supplies the external ones:

### Class (a) — inline, in-process `channel-mcp`

```ts
// packages/primary-node/src/agents/mcp-setup.ts:50-57
mcpServers['channel-mcp'] = createChannelMcpServer();   // inline transport
```

Tools surfaced (from the `contextTools` allow-list at `mcp-setup.ts:47` and the tool modules in
`packages/mcp-server/src/tools/`): `send_text`, `send_card`, `send_interactive`, `send_file`,
`push_to_agent`, plus the loop tools (`loop-start`/`loop-stop`/`loop-status`,
`packages/mcp-server/src/tools/loop-*.ts`). These are **inline MCP** — the server object lives
in-process; the Claude adapter passes it straight through via `adaptInlineMcpServer`
(`packages/core/src/sdk/providers/claude/options-adapter.ts` — `adaptMcpServers:124` dispatches by
server type, `adaptInlineMcpServer:157` wraps inline servers).

> **Overlap note:** these inline tools are functionally the same surface as the inline-tool work
> tracked in **#4387** (see open PR #4441 "inline-tool Zod→JSON-Schema parameter translation"). On
> the pi backend the inline `channel-mcp` tools can be exposed as `AgentHarnessTool`s **without**
> an MCP client — they are just in-process functions. So class (a) is largely covered by the
> inline-tool track, not by the MCP-client converter.

### Class (b) — external stdio servers (Playwright MCP + user-defined)

From the shipped config template:

```yaml
# disclaude.config.example.yaml:249-261
mcpServers:
  playwright:
    type: "stdio"
    command: "npx"
    args: ["@playwright/mcp@latest", "--cdp-endpoint", "http://disclaude-playwright:9222"]
```

plus any user-added stdio server (`disclaude.config.example.yaml:263-268`). `@playwright/mcp@^0.0.61`
is a direct dep of `@disclaude/core` (`packages/core/package.json`). These are the servers that
**require the MCP client converter** (B-Q2) on the pi backend: disclaude must spawn/connect an MCP
`Client`, `listTools()`, and wrap each as an `AgentHarnessTool`.

### Current pi-backend state

The pi options-adapter **already declares the gap and points at the fix**:

```ts
// packages/core/src/sdk/providers/pi/options-adapter.ts:38
// - `mcpServers`: the MCP→`AgentHarnessTool` converter, #4417 (S4b).
```

i.e. on the Claude path `adaptMcpServers` (`claude/options-adapter.ts:124`) hands both classes to
the Claude Agent SDK natively; on the pi path `mcpServers` is **dropped** today and explicitly
deferred to **#4417**. That is the exact scope the B1/B2/B3 decision governs.

---

## Recommendation + decision criteria (for #4383 decision (b))

**Recommendation: B1 (write the converter, #4417), conditional on the part-2 PoC confirming R1.**

Rationale, mapped to evidence:

- B1 is the **only** option that keeps class-(b) servers (Playwright + custom MCP) working. disclaude
  "rely heavily on MCP (Playwright MCP + inline tools)" (`docs/pi-agent-core-api-research.md:19-21`);
  Playwright browser automation is a user-facing capability, not a nice-to-have.
- B1 is **feasible and cheaper than feared** (B-Q2): schema translation is near-free because TypeBox
  *is* JSON-Schema and pi already pulls in `typebox@1.3.7`; the MCP client SDK is already a
  transitive dep (`@modelcontextprotocol/sdk@1.29.0`); the injection point (`setTools`) is first-class
  (B-Q3). No third-party schema-conversion lib is needed.
- "Wait for upstream" (a putative B1.5) is **dead as of 0.83.0** (B-Q1) — there is no upstream MCP
  to wait for.

**Decision criteria (which option, after part 2):**

| PoC outcome (part 2) | Pick |
|---|---|
| R1 holds — passthrough/rebuilt JSON-Schema works through pi's engine, ≥1 Playwright tool runs end-to-end | **B1** — proceed with #4417, full parity |
| R1 is real but a shallow `Type.*` rebuild fixes it (B-Q2.2 option b) | **B1** — slightly more code, still proceed |
| R1 forces a full hand-written JSON-Schema→TypeBox rebuild, or MCP-result mapping (R2) is a rabbit hole | **B3 now → B1 later** — ship text + inline tools, mark MCP `degraded`, revisit when ROI justifies the rebuild |
| ROI/timebox says "not now" regardless of feasibility | **B3** (staging), never **B2** |

**B2 (drop MCP, inline-only) is not recommended** — it is a permanent regression of a real
capability and is strictly dominated by B3 (which preserves the option to land B1 later).

---

## Deferred to part 2

Part 1 is deliberately **local-evidence-only**. The following are required to fully satisfy
[#4431](https://github.com/hs3180/disclaude/issues/4431) acceptance and are deferred:

1. **Playwright MCP end-to-end PoC** (resolves R1, R2) — write a minimal converter
   (`@modelcontextprotocol/sdk` `Client` + `StdioClientTransport` → `listTools` → wrap each as
   `AgentHarnessTool` → `harness.setTools`), connect to a Playwright MCP endpoint, and run one
   `callTool` through pi's `agentLoop`. Acceptance item: "Playwright MCP PoC has run/no-run
   evidence (if recommending B1)".
2. **Upstream roadmap / release-notes web survey** — confirm there is no announced MCP plan in the
   pi repo's releases/discussions (strengthens the B-Q1 "not viable to wait" conclusion beyond the
   0.83.0 code fact). Zero web sources are cited in part 1; this is the one place they belong.
3. **Convert the recommendation into a #4417 scope note** once the PoC selects the row in the
   decision table above.

Until part 2 lands, the recommendation above is honestly labeled **conditional**.

---

## Acceptance checklist (#4431)

- [x] **B-Q1 answered with evidence** — 0.83.0 grep, 0 MCP symbols across all three packages.
- [x] **B-Q2 answered with evidence** — `AgentHarnessTool`/`AgentTool`/`AgentToolResult` shapes,
      `typebox@1.3.7` JSON-Schema parity, `@modelcontextprotocol/sdk@1.29.0` availability, risk
      register R1-R5.
- [x] **B-Q3 answered with evidence** — `setTools` is the bridge; no MCP-specific plugin exists.
- [x] **B-Q4 answered with evidence** — `channel-mcp` (inline) + Playwright/user stdio; pi adapter
      deferral site `pi/options-adapter.ts:38`.
- [x] **Latest pi-agent-core MCP status re-verified (not just 0.82.1)** — 0.83.0 re-verified here.
- [ ] **Playwright MCP PoC run evidence** — **deferred to part 2** (hence the conditional
      recommendation; not fabricated).
- [x] **Report gives a recommendation + decision criteria** — B1 conditional, with a PoC-gated
      decision table.

---

## References (all local; pi line numbers are the package's own `dist`)

- pi `dist/types.d.ts`: `AgentTool` :333, `AgentToolResult` :310, `execute` :342,
  `AgentContext.tools` :359, `AgentLoopConfig.convertToLlm` :145.
- pi `dist/harness/types.d.ts`: `AgentHarnessTool` :58, `AgentHarnessOptions.tools` :656.
- pi `dist/harness/agent-harness.d.ts`: `setTools` :76, `setActiveTools` :78.
- `typebox@1.3.7`: `build/value/index.d.mts:1-19`, `build/schema/engine/type.mjs:8,27`.
- disclaude: `packages/core/src/sdk/providers/pi/options-adapter.ts:16-20,25,38`;
  `packages/core/src/sdk/providers/claude/options-adapter.ts` (`adaptMcpServers:124`,
  `adaptInlineMcpServer:157`);
  `packages/primary-node/src/agents/mcp-setup.ts` (`buildMcpServers:33-75`,
  `collectInlineMcpInstances:99`, `contextTools:47`);
  `packages/core/src/config/index.ts:521`; `disclaude.config.example.yaml:249-268`;
  `package-lock.json` (`@modelcontextprotocol/sdk@1.29.0`).
- Companion: `docs/pi-agent-core-api-research.md` (#4384 spike).
