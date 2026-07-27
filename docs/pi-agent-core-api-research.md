# pi-agent-core API Surface — Spike Findings (#4384)

> Status: research/spike. No production code changed. Cross-linked to #4384 / #4383.
> Method: `npm install @earendil-works/pi-agent-core@0.82.1` in a scratch setup;
> evidence below is taken from the package's TypeScript declarations
> (`dist/**/*.d.ts`), which are authoritative for the runtime API surface.

## TL;DR

- **Package**: `@earendil-works/pi-agent-core` **v0.82.1** — the in-process agent
  loop. This is the option #4383 leans toward ("pi-agent-core, in-process loop,
  preferred") and the spike confirms it: it exports `agentLoop` / `runAgentLoop`
  and a higher-level `AgentHarness` class. **Use `pi-agent-core`** (not the
  `pi-coding-agent` CLI, not `pi-ai`-only). `pi-ai` is pulled in transitively as
  the model/streaming primitive.
- **Abort**: standard `AbortSignal` passed to `agentLoop(...)` — clean, direct
  mapping to disclaude's `QueryHandle.cancel()`.
- **Streaming events**: a well-typed discriminated union `AgentEvent` (see table).
- **⚠️ MCP is NOT native.** Zero `mcp`/`Mcp`/`MCP` symbols across the whole
  package. disclaude's MCP servers (Playwright MCP, inline tools) will need an
  **MCP → `AgentHarnessTool` converter** in S4. This is the biggest unknown
  called out in #4383 §5 and it is now confirmed: S4 is real work, not a config
  flag.
- **Tool format differs**: pi uses **TypeBox** (`TSchema`) parameter schemas +
  a richer `execute(toolCallId, params, signal, onUpdate, context)` signature;
  disclaude `InlineToolDefinition` uses **Zod** + `handler(params)`. Schema and
  signature conversion needed in S4.
- **Version posture**: 0.82.1 — **pre-1.0**. Expect breaking changes; pin the
  version and re-run this check on bumps.

---

## 1. MCP — NOT natively consumed ❌

`grep -rn -iE 'mcp' dist/**/*.d.ts` returns **no matches**. The package has no
MCP client/server types. Tool calling is exclusively through its own
`AgentHarnessTool` format (see §3) plus a set of **built-in harness tools**
(`bash`, `read`, `write`, `edit`, `image`, `edit-diff`, `file-mutation-queue`
under `dist/harness/tools/`).

**Implication for #4383 S4**: disclaude relies heavily on MCP (Playwright MCP +
inline tools exposed as MCP). To run those under pi, S4 must bridge each MCP
server's tools into `AgentHarnessTool`s (wrap each MCP tool's schema + call into
an `execute`). This is a converter, not a one-line integration — size S4
accordingly. `createMcpServer` in disclaude's `IAgentSDKProvider` has no pi
equivalent.

## 2. Streaming events — `AgentEvent` discriminated union

`agentLoop(...)` returns `EventStream<AgentEvent, AgentMessage[]>`
(`agent-loop.d.ts:12`). `AgentEvent` (`types.ts:368`) is:

| pi `AgentEvent.type`   | payload highlights                              | → disclaude `AgentMessageType` |
| ---------------------- | ----------------------------------------------- | ------------------------------ |
| `agent_start`          | —                                               | `status` (session start)       |
| `message_start`        | `message: AgentMessage`                         | `status` (turn boundary)       |
| `message_update`       | `message` + `assistantMessageEvent` (text/tool delta) | `text` (and `tool_use` when the delta carries a tool call) |
| `message_end`          | `message`                                       | `text` (final assistant text)  |
| `tool_execution_start` | `toolCallId`, `toolName`, `args`                | `tool_use`                     |
| `tool_execution_update`| `toolCallId`, `toolName`, `partialResult`       | `tool_progress`                |
| `tool_execution_end`   | `toolCallId`, `toolName`, `result`, `isError`   | `tool_result` (set `isError`)  |
| `turn_end`             | `message` + `toolResults[]`                     | `tool_result` batch / `text`   |
| `agent_end`            | `messages: AgentMessage[]`                      | `result`                       |

`AssistantMessageEvent` (from `@earendil-works/pi-ai`) is the raw model stream
delta carried on `message_update`; S3's message-adapter should read text/tool
deltas off it. Reasoning/thinking deltas were not present as a distinct event
type in 0.82.1 (no `reasoning`/`thinking` symbol) — confirm at S3 impl time if
reasoning streaming is needed.

## 3. Tool definition format — TypeBox + richer execute

pi (`harness/types.ts:58`):

```ts
type AgentHarnessTool<TContext, TParameters extends TSchema = TSchema, TDetails = unknown>
  = Omit<AgentTool<TParameters, TDetails>, 'execute'> & {
    execute(toolCallId: string,
            params: Static<TParameters>,
            signal: AbortSignal | undefined,
            onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
            context: TContext): Promise<AgentToolResult<TDetails>>;
  };
```

disclaude (`sdk/types.ts:190`):

```ts
interface InlineToolDefinition<TParams, TResult> {
  name: string;
  description: string;
  parameters: ZodSchema<TParams>;          // Zod
  handler: (params: TParams) => Promise<TResult>;   // simple
}
```

**Delta to bridge in S4**:

1. **Schema**: Zod → TypeBox (`TSchema`). Convert the Zod schema to a TypeBox
   schema (or author pi tools natively in TypeBox and convert the other way for
   disclaude's MCP-facing surface).
2. **execute signature**: pi's `execute` takes `(toolCallId, params, signal,
   onUpdate, context)` — richer than disclaude's `handler(params)`. The adapter
   must supply `signal` (the run's `AbortSignal`), forward progress via
   `onUpdate` → disclaude `tool_progress`, and return an `AgentToolResult`
   (not a bare `TResult`).
3. **Context**: pi tools are generic over a per-run `TContext` (resolved per
   turn snapshot). disclaude tools are stateless. The adapter can use
   `undefined` for `TContext` or inject a disclaude-side context object.

## 4. Abort / interrupt — standard `AbortSignal` ✅

`agentLoop(prompts, context, config, signal: AbortSignal | undefined, streamFn)`
(`agent-loop.d.ts:12`). Same for `runAgentLoop`, `agentLoopContinue`,
`runAgentLoopContinue`. Hooks (`beforeToolCall`, `afterToolCall`,
`prepareNextTurn`, `transformContext`) also receive `signal?`.

**Mapping**: disclaude's `QueryHandle.cancel()`
(`packages/core/src/sdk/types.ts:308`) → hold an `AbortController`, pass
`controller.signal` into `agentLoop`, and call `controller.abort()` on
`cancel()`. Direct, no translation layer needed.

## 5. Package selection — `pi-agent-core` (decision)

| option                | verdict | why |
| --------------------- | ------- | --- |
| **`pi-agent-core`** ✅ | chosen  | In-process loop (`agentLoop`/`AgentHarness`); full event stream; AbortSignal; tool hooks. Matches #4383 lean. |
| `pi-coding-agent` CLI | reject  | Shell-out; loses the in-process event stream and the AbortSignal handle; harder to map onto `IAgentSDKProvider`. |
| `pi-ai`-only          | reject  | Only the model streaming primitive; disclaude would have to reimplement the agent loop, tool dispatch, compaction. `pi-agent-core` already wraps `pi-ai` (`StreamFn`). |

## 6. Version + stability

- Installed: **0.82.1** (latest at spike time). `main`/`types`:
  `./dist/index.js` / `./dist/index.d.ts`. Exports: `.`, `./node`, `./package.json`.
- **Pre-1.0** — treat the surface as unstable: pin the exact version, add a
  re-verification step (re-run this doc's grep checks) on any bump. The
  `AgentEvent` union and `AgentHarnessTool.execute` signature are the most
  likely to churn.

## Acceptance (#4384)

- [x] MCP answer recorded with evidence (no `mcp` symbols in `dist/**/*.d.ts`)
- [x] Streaming-event ↔ `AgentMessageType` mapping table (§2)
- [x] Tool-format ↔ `InlineToolDefinition` delta noted (§3)
- [x] Abort mechanism documented (§4 — `AbortSignal`)
- [x] Package selection decided: `pi-agent-core` (§5)
- [x] Version + stability note (§6 — 0.82.1, pre-1.0)

## Unblocks

- **S3** (`#4386` — `PiAgentProvider.queryStream`): build the message adapter
  per §2 and the AbortSignal wiring per §4.
- **S4** (`#4387` — tools/MCP): the MCP→`AgentHarnessTool` converter per §1/§3
  is the substantial part.

Related: #4384, #4383, #4385 (PiAgentProvider skeleton), #4388 (agentBackend config).
