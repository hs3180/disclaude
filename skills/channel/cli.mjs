#!/usr/bin/env node
/**
 * channel Skill — CLI helper (Issue #4459, parts 3–7)
 *
 * CLI-Skill replacement for the inline `channel-mcp` MCP server
 * (`packages/mcp-server/src/channel-mcp.ts`, surface S1 in
 * `docs/mcp-server-inventory.md`). Part of the "reduce MCP" direction
 * (#4383, owner decision 2026-08-07): disclaude unifies both backends on the
 * Skills (CLI + README) model defined in `docs/skill-format-spec.md`.
 *
 * Subcommands implemented so far:
 *   • send_text       (part 3, PR #4467)
 *   • send_file       (part 4, PR #4494)
 *   • send_card       (part 5, this change)
 *   • push_to_agent  (part 6, PR #4501)
 *   • send_interactive (part 7, PR #4502)
 * Each reuses the SAME first-party implementation from `@disclaude/mcp-server`
 * — the CLI does not re-implement the Feishu send path. All reach the
 * PrimaryNode over the REST IPC face (`DISCLAUDE_REST_IPC_ENABLED=true` is set
 * below BEFORE the first `@disclaude/mcp-server` import, so the core
 * `getIpcClient()` singleton and the `isIpcAvailable()` probe both select
 * `RestIpcClient` — Issue #4532: the channel CLI must work with no Unix socket
 * at all). This CLI is a one-shot process per call that POSTs to the
 * PrimaryNode's HttpApiServer and exits. No long-lived session is required for
 * a single send.
 *
 * Transport wiring (#4532 scope 1+2): base URL from --base-url >
 * DISCLAUDE_REST_IPC_BASE_URL > http://localhost:9200; bearer token from
 * DISCLAUDE_REST_IPC_API_TOKEN (passed through to POST routes; the PrimaryNode
 * started without --api-token accepts any request). One-shot CLI processes
 * inherit these env vars from the agent's runtime env (.runtime-env is merged
 * into the SDK env by base-agent createSdkOptions, Issue #1361) — no socket
 * path discovery file is consulted on this path.
 *
 * send_card parity note: the first-party `send_card` fn does NOT apply the
 * GFM-table conversion (#2340) or local-image auto-upload (#2951) — those live
 * in the channel-mcp ENTRY handler. So `cmdSendCard` replicates that handler's
 * pipeline (validate → transformCardTables → resolveCardImages → send_card →
 * annotate) using helpers now exported from `@disclaude/mcp-server`, so the CLI
 * matches the inline MCP tool instead of silently dropping those features.
 *
 * send_interactive note (part 7): it forwards the RAW parameters (question,
 * options, title, context, actionPrompts) to the PrimaryNode via the
 * `sendInteractive` IPC; the PrimaryNode builds the interactive card, sends it,
 * and registers the button-click action prompts (#1571/#1572). Button handling
 * lives on the PrimaryNode side — this CLI is a one-shot *client*, exactly like
 * `send_text`, NOT the IPC server / button handler.
 *
 * Output contract — exactly ONE JSON object on stdout (see spec §2.2):
 *   success: { ok: true,  command: "send_text", chatId, result, durationMs }
 *   failure: { ok: false, command: "send_text", error, hint? }   (exit code 1)
 * The agent parses stdout JSON; stderr is for diagnostics only. The pino logger
 * used inside `send_text` writes to stdout by default, so this CLI temporarily
 * redirects stdout → stderr for the duration of the IPC call to keep the result
 * object the only thing on stdout.
 *
 * Part 4 (send_file) — same pattern, reusing `send_file` from
 * `@disclaude/mcp-server` (uploads via IPC to the PrimaryNode). Relative paths
 * are resolved against the configured workspace dir by the first-party impl;
 * file existence is NOT pre-validated here for that reason.
 *
 * #4532 part 1 — REST transport switch. When the REST face is unreachable
 * (PrimaryNode not started / port not open), the underlying fetch fails with
 * ECONNREFUSED / ENOTFOUND-style errors; `failureHint` below turns those into
 * the actionable "PrimaryNode REST <url> unreachable, start the main service
 * first" hint instead of surfacing the raw fetch error (#4532 scope 3).
 *
 * Deferred (later parts of #4459) — out of scope here:
 *   • the S2 external-MCP-loader removal and live end-to-end delivery
 *     verification (tracked on the parent issue).
 *   • live end-to-end parity verification against the MCP tool (requires a
 *     running PrimaryNode + Feishu credentials); this CLI verifies the command
 *     surface, output contract, validation, and graceful-degradation paths
 *     only — mirroring how #4464 part 1 deferred live-browser parity.
 *   • per-chat capability gating parity (the MCP layer gates on
 *     `supportedMcpTools`; a CLI is invoked at the agent's discretion) — see
 *     README §Parity.
 *
 * Part 11 (chatId-format pre-check parity, REST re-land of rejected #4521):
 * parts 3/4/6/7 checked --chat for presence only and deferred the FORMAT
 * check to the transport layer. Every MCP entry handler runs a
 * getChatIdValidationError format pre-check (#1641); the REST handlers
 * validate chatId as a non-empty string only, so on the REST CLI the up-front
 * twin gate (parseChatId below) is the only place the format rules run.
 * send_card keeps the exported helper post-import too (part 5, unchanged
 * shape) — the twin must agree with it byte-for-byte.
 *
 * Usage:
 *   node skills/channel/cli.mjs --help
 *   node skills/channel/cli.mjs send_text --chat oc_xxx --text "Hello"
 *   echo "long body" | node skills/channel/cli.mjs send_text --chat oc_xxx
 *   node skills/channel/cli.mjs send_file --chat oc_xxx --file ./report.pdf
 *   node skills/channel/cli.mjs send_card --chat oc_xxx --card-file ./card.json
 *   node skills/channel/cli.mjs push_to_agent --chat oc_xxx --message "Summarize the thread"
 *
 * Parts 3–7 + 11 of #4459, REST transport switch from #4532 part 1 — does not
 * auto-close the parent issues.
 */

import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";

const VERSION = "0.1.0";
const COMMAND = "channel";

const HELP = `channel Skill — CLI replacement for the channel-mcp inline MCP server (#4459).

Usage:
  node skills/channel/cli.mjs <command> [options]
  <large text> | node skills/channel/cli.mjs <command> --chat <id>

Commands:
  send_text        Send a plain text message to a chat (part 3).
  send_file        Send a file to a chat (part 4).
  send_card        Send a display-only Feishu card (part 5). GFM tables in
                   markdown elements are auto-converted to column_set; local
                   image paths are auto-uploaded — feature parity with the MCP
                   tool.
  push_to_agent    Push an instruction to the chat agent for a chat, creating
                   the agent lazily if needed (part 6).
  send_interactive Send an interactive card with clickable buttons (part 7).
  help             Show this help message.

send_text options:
  --chat <id>          Target chat ID (e.g. oc_xxx). Required.
  --text <string>      Text content. Required unless --text-file or stdin is used.
  --text-file <path>   Read text content from a file (use "-" for stdin explicitly).
  --parent <id>        Optional parent message ID (thread reply).
  --mentions <json>    Optional JSON array of { "openId": string, "name"?: string }.
  --help, -h           Show this help message.

send_interactive options:
  --chat <id>            Target chat ID (e.g. oc_xxx). Required.
  --question <string>    The question / main content to display. Required unless
                         --question-file or stdin is used.
  --question-file <path> Read question from a file (use "-" for stdin explicitly).
  --options <json>       Required JSON array of button options, each
                         { "text": string, "value": string, "type"?: "primary"
                         | "default" | "danger" }. The PrimaryNode builds the
                         card; button clicks are routed to the agent as prompts.
  --title <string>       Optional card title (defaults to "交互消息").
  --context <string>     Optional context shown above the question.
  --action-prompts <json> Optional JSON object mapping option value -> prompt
                         string (overrides the auto-generated default prompts).
  --parent <id>          Optional parent message ID (thread reply).
  --help, -h             Show this help message.

send_file options:
  --chat <id>          Target chat ID (e.g. oc_xxx). Required.
  --file <path>        Path to the file to send. Required. Relative paths are
                      resolved against the configured disclaude workspace dir.
  --parent <id>        Optional parent message ID (thread reply).
  --help, -h           Show this help message.

send_card options:
  --chat <id>          Target chat ID (e.g. oc_xxx). Required.
  --card <json>        Card JSON object. Required unless --card-file or stdin is used.
  --card-file <path>   Read card JSON from a file (use "-" for stdin explicitly).
  --parent <id>        Optional parent message ID (thread reply).
  --help, -h           Show this help message.

push_to_agent options:
  --chat <id>             Target chat ID (e.g. oc_xxx). Required.
  --message <string>      Instruction text to push. Required unless --message-file
                          or stdin is used.
  --message-file <path>   Read instruction from a file (use "-" for stdin).
  --help, -h              Show this help message.

Output:
  Exactly one JSON object on stdout (exit 0 on success, 1 on failure):
    {"ok":true,"command":"send_text","chatId":"oc_xxx","result":"...","durationMs":12}
    {"ok":true,"command":"send_card","chatId":"oc_xxx","result":"...","durationMs":42}
    {"ok":false,"command":"send_card","error":"...","hint":"..."}
    {"ok":true,"command":"push_to_agent","chatId":"oc_xxx","result":"...","durationMs":12}

Transport (all subcommands):
  The CLI talks to the PrimaryNode's REST API — no Unix-socket IPC (#4532).
  --base-url <url>            Base URL of the PrimaryNode REST API. Default:
                              $DISCLAUDE_REST_IPC_BASE_URL or
                              http://localhost:9200.
  The bearer token for POST routes comes from DISCLAUDE_REST_IPC_API_TOKEN
  (unset is fine when the PrimaryNode runs without --api-token).

Runtime:
  Reuses send_text / send_file / send_card (and card preprocessing helpers) from
  @disclaude/mcp-server, which needs a running disclaude PrimaryNode (REST API
  on the --base-url port) and Feishu credentials. Run inside a disclaude
  workspace where the packages are built.

Examples:
  node skills/channel/cli.mjs send_text --chat oc_abc --text "Hello, world!"
  echo "status: ok" | node skills/channel/cli.mjs send_text --chat oc_abc
  node skills/channel/cli.mjs send_text --chat oc_abc --text-file ./msg.txt --parent om_parent
  node skills/channel/cli.mjs send_text --chat oc_abc --text "@owner pls review" \\
    --mentions '[{"openId":"ou_xxx","name":"owner"}]'
  node skills/channel/cli.mjs send_file --chat oc_abc --file ./report.pdf
  node skills/channel/cli.mjs send_file --chat oc_abc --file ./log.txt --parent om_parent
  node skills/channel/cli.mjs push_to_agent --chat oc_abc --message "Summarize unread messages"
  echo "long instruction" | node skills/channel/cli.mjs push_to_agent --chat oc_abc
  node skills/channel/cli.mjs send_card --chat oc_abc --card-file ./card.json
  echo '{"elements":[{"tag":"markdown","content":"hi"}]}' \\
    | node skills/channel/cli.mjs send_card --chat oc_abc

  node skills/channel/cli.mjs send_interactive --chat oc_abc \
    --question "Which option do you prefer?" \
    --options '[{"text":"Approve","value":"approve","type":"primary"},
                {"text":"Reject","value":"reject","type":"danger"}]' \
    --title "Code Review"
  echo "Deploy to prod?" | node skills/channel/cli.mjs send_interactive --chat oc_abc \
    --options '[{"text":"yes","value":"yes"},{"text":"no","value":"no"}]' \
    --action-prompts '{"yes":"[user] approved deploy","no":"[user] rejected deploy"}'

Version ${VERSION} — parts 3–7 of #4459 + REST transport (#4532 part 1). This Skill does not auto-close the parent issue.`;

// ---------------------------------------------------------------------------
// Output helpers — every command result is ONE JSON object on stdout.
// ---------------------------------------------------------------------------

// Guards the single-JSON-object stdout contract. Each emit* sets this and
// becomes a no-op once a result has already been written. This matters on
// fast-failure paths: withStdoutToStderr's process.stdout.write redirect can
// leave pino's SonicBoom stream "not ready", and process.exit() then triggers
// its on-exit flushSync, which throws; that throw reaches the top-level
// .catch() below, which would otherwise emitFail() a spurious second
// "CLI crashed" line. With this guard the crash trace stays on stderr
// (diagnostics, per spec §2.2) while stdout remains exactly one line.
let stdoutResultEmitted = false;

function emitOk(payload) {
  if (stdoutResultEmitted) return;
  stdoutResultEmitted = true;
  process.stdout.write(JSON.stringify({ ok: true, ...payload }) + "\n");
}

function emitFail(command, error, hint) {
  if (stdoutResultEmitted) return;
  stdoutResultEmitted = true;
  const body = { ok: false, command, error };
  if (hint) body.hint = hint;
  process.stdout.write(JSON.stringify(body) + "\n");
}

/**
 * Exit with `code`, tolerating pino's process-exit teardown artifact.
 *
 * The `@disclaude/mcp-server` pino loggers register a process `onExit` handler
 * (via on-exit-leak-free) that calls `SonicBoom.flushSync`. When a logger was
 * created (module imported) but never written to — e.g. send_card rejects an
 * invalid card BEFORE send_card logs its first line — the sonic-boom stream is
 * "not ready" and flushSync throws during `process.exit`. The result JSON has
 * already been emitted by then, so we swallow this teardown artifact and force
 * the exit code rather than letting it surface as a duplicate crash JSON.
 */
function exitWithCode(code) {
  try {
    process.exit(code);
  } catch {
    process.exitCode = code;
  }
}

/**
 * Run `fn` with process.stdout.write redirected to process.stderr, so any
 * third-party logging (pino inside send_text writes to stdout by default) does
 * not corrupt the single-JSON-object stdout contract. Diagnostics belong on
 * stderr per the Skill format spec §2.2.
 */
async function withStdoutToStderr(fn) {
  const originalWrite = process.stdout.write;
  // pino calls `stream.write(...)`, where stream === process.stdout; routing the
  // write method to stderr intercepts its output without touching the logger.
  process.stdout.write = function (chunk, encoding, callback) {
    return process.stderr.write(chunk, encoding, callback);
  };
  try {
    return await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
}

// ---------------------------------------------------------------------------
// REST transport wiring (Issue #4532 part 1)
// ---------------------------------------------------------------------------

/** Default REST base URL of the PrimaryNode HttpApiServer (#4168 decision 3). */
const DEFAULT_REST_BASE_URL = "http://localhost:9200";

/**
 * Force the REST IPC transport for this one-shot process (#4532 scope 1: the
 * CLI must work with no Unix socket at all — no default IPC fallback).
 *
 * Must run BEFORE the first `import("@disclaude/mcp-server")`: the core
 * `getIpcClient()` singleton and the mcp-server `isIpcAvailable()` probe both
 * branch on `DISCLAUDE_REST_IPC_ENABLED === 'true'` at call time, and every
 * send path (including `resolveCardImages`' internal `getIpcClient()` for
 * local-image upload) funnels through them. Setting the env here — in a
 * process that starts with no disclaude env at all — selects `RestIpcClient`
 * for the whole process lifetime.
 *
 * Called ONCE from main() before command dispatch — not per command — so any
 * future subcommand inherits the REST wiring by construction; a forgotten
 * call site can no longer silently fall back to the Unix socket.
 *
 * Returns the resolved base URL (flag > env > default) for failure hints.
 */
function wireRestTransport(args) {
  let baseUrl;
  if (args && typeof args["base-url"] === "string" && args["base-url"].length > 0) {
    baseUrl = args["base-url"];
  } else {
    baseUrl = process.env.DISCLAUDE_REST_IPC_BASE_URL || DEFAULT_REST_BASE_URL;
  }
  process.env.DISCLAUDE_REST_IPC_ENABLED = "true";
  process.env.DISCLAUDE_REST_IPC_BASE_URL = baseUrl;
  // DISCLAUDE_REST_IPC_API_TOKEN passes through from the ambient env when set
  // (injected into the agent runtime env via .runtime-env, Issue #1361); the
  // CLI never needs to know its value.
  return baseUrl;
}

/**
 * Actionable hint for REST-reachability failures (#4532 scope 3): when the
 * underlying fetch fails to connect (ECONNREFUSED / ENOTFOUND / timeout —
 * surfaced through the IPC error contract as IPC_NOT_AVAILABLE / IPC_TIMEOUT)
 * or the availability probe itself reported down, tell the operator to start
 * the PrimaryNode instead of leaving a raw socket error on the table.
 */
function restUnavailableHint(baseUrl) {
  return `PrimaryNode REST ${baseUrl} unreachable — start the main service (disclaude-primary start --api-port <port>) or pass --base-url / DISCLAUDE_REST_IPC_BASE_URL`;
}

/**
 * Probe GET /api/ping directly from the CLI (no @disclaude/mcp-server import
 * needed — plain fetch). Used on the failure path to decide whether the
 * actionable "REST unreachable" hint applies.
 *
 * Why a CLI-side probe instead of string-matching alone: the first-party tools
 * gate in an order the CLI does not control — e.g. send_text checks Feishu
 * credentials BEFORE the IPC availability probe, so on a credential-less host
 * a down REST face surfaces as "Feishu credentials not configured", which no
 * transport-flavored regex can distinguish from a real credentials problem.
 * Probing here makes the hint conditional on the ACTUAL reachability of the
 * REST face, independent of which first-party gate fired first. The probe is
 * token-exempt (GET route) and short-timeout; it only runs after a send has
 * already failed, so the happy path pays nothing.
 *
 * Timeout is 3s vs mcp-server isIpcAvailable()'s 2000ms: intentional — this
 * probe runs only on the failure path (never latency-critical), so it can
 * afford to be more patient before declaring the REST face unreachable.
 */
async function isRestFaceReachable(baseUrl) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/ping`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const json = await res.json();
    return json && json.pong === true;
  } catch {
    return false;
  }
}

/**
 * Decide the failure hint for a send that already failed: if the REST face is
 * verifiably down (probe fails), the root cause is reachability — return the
 * actionable hint; otherwise the failure is genuinely something else (creds,
 * card validation, Feishu API error) and no transport hint is added.
 */
async function failureHintForSend(baseUrl) {
  const reachable = await isRestFaceReachable(baseUrl);
  return reachable ? undefined : restUnavailableHint(baseUrl);
}

/**
 * Detect a REST-unreachable style failure. Two layers produce it: the IPC error
 * contract prefixes (`IPC_NOT_AVAILABLE` / `IPC_TIMEOUT` from RestIpcClient /
 * the facade) and the first-party tools' friendly availability-gate messages
 * (`IPC service unavailable…` / `IPC not available` / `❌ IPC 服务不可用…`,
 * emitted when the `/api/ping` probe fails). Raw fetch causes (ECONNREFUSED /
 * ENOTFOUND) are matched too, in case a future call site lets one through.
 */
function isRestUnreachable(message) {
  return (
    typeof message === "string" &&
    /IPC_NOT_AVAILABLE|IPC_TIMEOUT|IPC service unavailable|IPC not available|IPC 服务不可用|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(
      message
    )
  );
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      args[key] = value;
      i += 1; // consume the value; flags are value-taking only (long-form, spec §2.1)
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function readStdinSync() {
  // Synchronous stdin read for piped input. Only used when stdin is not a TTY.
  try {
    return readFileSync(0, "utf8");
  } catch {
    return null;
  }
}

function parseMentions(raw) {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("mentions must be a JSON array");
    }
    for (const m of parsed) {
      if (typeof m !== "object" || m === null || typeof m.openId !== "string") {
        throw new Error("each mention must be an object with an `openId` string");
      }
    }
    return parsed.map((m) => ({ openId: m.openId, ...(m.name ? { name: m.name } : {}) }));
  } catch (err) {
    throw new Error(`Invalid --mentions JSON: ${err.message}`);
  }
}

/**
 * Parse and validate the `--options` JSON array for send_interactive. Mirrors the
 * first-party `send_interactive_message` validation (interactive-message.ts) so
 * invalid options fail cheaply before importing @disclaude/mcp-server. Each
 * option must be { text: non-empty string, value: non-empty string, type?:
 * "primary" | "default" | "danger" }.
 */
function parseOptions(raw) {
  if (!raw) {
    throw new Error("Missing required option --options <json-array>");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid --options JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("options must be a JSON array");
  }
  if (parsed.length === 0) {
    throw new Error("options must be a non-empty array");
  }
  for (let i = 0; i < parsed.length; i++) {
    const opt = parsed[i];
    if (typeof opt !== "object" || opt === null) {
      throw new Error(`options[${i}] must be an object`);
    }
    if (typeof opt.text !== "string" || opt.text.trim().length === 0) {
      throw new Error(`options[${i}].text must be a non-empty string`);
    }
    if (typeof opt.value !== "string" || opt.value.trim().length === 0) {
      throw new Error(`options[${i}].value must be a non-empty string`);
    }
    if (
      opt.type !== undefined &&
      !["primary", "default", "danger"].includes(opt.type)
    ) {
      throw new Error(`options[${i}].type must be one of: primary, default, danger`);
    }
  }
  return parsed.map((opt) => ({
    text: opt.text,
    value: opt.value,
    ...(opt.type !== undefined ? { type: opt.type } : {}),
  }));
}

/**
 * Parse the optional `--action-prompts` JSON object (value -> prompt string)
 * for send_interactive. Returns undefined when not provided so the PrimaryNode
 * uses its auto-generated default prompts.
 */
function parseActionPrompts(raw) {
  if (!raw) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid --action-prompts JSON: ${err.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "action-prompts must be a JSON object mapping option value -> prompt string"
    );
  }
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val !== "string" || val.length === 0) {
      throw new Error(`action-prompts["${key}"] must be a non-empty string`);
    }
  }
  return parsed;
}

/**
 * The chatId-format half of `parseChatId` below, without the
 * @disclaude/mcp-server dependency. The MCP entry handlers pre-check the
 * chatId FORMAT via getChatIdValidationError (channel-mcp.ts, #1641) so an
 * ill-formed id fails cheaply instead of surfacing as a confusing HTTP 400
 * deep inside the transport. `cmdSendCard` (part 5) already replicates that
 * pre-check post-import via the exported helper; this part extends the same
 * pre-check to the other four subcommands, keeping it pre-import (a format
 * failure never pays the module load). The REST handlers only validate
 * `chatId` as a non-empty string server-side (http-api-server.ts), so on the
 * REST CLI the up-front format gate is the ONLY place the twin rules run —
 * without it an ill-formed id surfaces as a 4xx Feishu error behind the
 * server. The format table (oc_/ou_/cli- prefixes) is tiny and stable, so
 * this twin is safe to inline; cli.test.ts locks both paths — the twin via
 * the four fail-fast cases, the exported helper via the send_card regression
 * case — against the same ill-formed example plus prefix/length/whitespace
 * edges.
 */
const CHAT_ID_PATTERNS = [
  { prefix: "oc_", label: "Feishu group chat", minLength: 35 },
  { prefix: "ou_", label: "Feishu user (p2p chat)", minLength: 35 },
  { prefix: "cli-", label: "CLI session", minLength: 5 },
];

function isValidChatIdFormat(chatId) {
  if (chatId !== chatId.trim()) return false;
  return CHAT_ID_PATTERNS.some(
    ({ prefix, minLength }) => chatId.startsWith(prefix) && chatId.length >= minLength
  );
}

function getChatIdFormatError(chatId) {
  if (isValidChatIdFormat(chatId)) return null;
  // Labels are carried so the twin's message stays byte-identical to the
  // authoritative getChatIdValidationError (chat-id-validator.ts).
  const formatList = CHAT_ID_PATTERNS.map(
    ({ prefix, label }) => `- \`${prefix}...\` (${label})`
  ).join("\n");
  const shown = chatId.length > 20 ? `${chatId.slice(0, 20)}...` : chatId;
  return (
    `Invalid chatId format: "${shown}"\n` +
    `Expected one of the following formats:\n${formatList}`
  );
}

/**
 * Validate the --chat value for a subcommand: presence + format (mirrors the
 * MCP entry handler pre-checks, #1641). cmdSendCard keeps using the exported
 * getChatIdValidationError post-import so the two paths stay provably
 * identical for the one command that already had it (part 5); this pre-import
 * twin covers the rest.
 *
 * Returns { chatId } on success, or { code: 1 } after emitting the failure.
 */
function parseChatId(command, rawChatId) {
  if (!rawChatId || typeof rawChatId !== "string") {
    emitFail(command, "Missing required option --chat <id>", `pass --chat oc_xxx`);
    return { code: 1 };
  }
  const formatError = getChatIdFormatError(rawChatId);
  if (formatError) {
    emitFail(command, `Invalid chatId: ${formatError}`);
    return { code: 1 };
  }
  return { chatId: rawChatId };
}

// ---------------------------------------------------------------------------
// send_text command
// ---------------------------------------------------------------------------

async function cmdSendText(argv) {
  const args = parseArgs(argv);
  const start = performance.now();

  // --- validate (before any import, so failures are cheap and deterministic) ---
  const chat = parseChatId("send_text", args.chat);
  if (chat.code) return chat.code;
  const chatId = chat.chatId;

  // Resolve text: --text, --text-file, or piped stdin (when stdin is not a TTY).
  let text;
  if (typeof args.text === "string") {
    text = args.text;
  } else if (typeof args["text-file"] === "string") {
    const file = args["text-file"];
    try {
      text = file === "-" ? readStdinSync() : readFileSync(file, "utf8");
    } catch (err) {
      emitFail("send_text", `Cannot read --text-file ${file}: ${err.message}`);
      return 1;
    }
  } else if (!process.stdin.isTTY) {
    // isTTY is `undefined` (not false) when stdin is a pipe/redirect.
    text = readStdinSync();
  }

  if (!text || text.length === 0) {
    emitFail(
      "send_text",
      "Missing text content",
      "pass --text <string>, --text-file <path>, or pipe content on stdin"
    );
    return 1;
  }

  let mentions;
  try {
    mentions = parseMentions(args.mentions);
  } catch (err) {
    emitFail("send_text", err.message);
    return 1;
  }

  const parentMessageId = typeof args.parent === "string" ? args.parent : undefined;

  // --- transport wiring happens ONCE in main() before dispatch (#4532); the
  //     resolved base URL is re-derived here (same flag > env > default order)
  //     purely for failure hints — no env is mutated at this point. ---
  const baseUrl = process.env.DISCLAUDE_REST_IPC_BASE_URL;

  // --- execute (stdout redirected → stderr so logger noise stays off stdout) ---
  let mod;
  try {
    mod = await withStdoutToStderr(() => import("@disclaude/mcp-server"));
  } catch (err) {
    emitFail(
      "send_text",
      `Failed to load @disclaude/mcp-server: ${err.message}`,
      "run inside a disclaude workspace with packages built (npm run build); the CLI reuses send_text from @disclaude/mcp-server"
    );
    return 1;
  }

  const sendText = mod.send_text;
  if (typeof sendText !== "function") {
    emitFail("send_text", "@disclaude/mcp-server does not export send_text (unexpected build)");
    return 1;
  }

  let result;
  try {
    result = await withStdoutToStderr(() =>
      sendText({ text, chatId, parentMessageId, mentions })
    );
  } catch (err) {
    emitFail(
      "send_text",
      `send_text threw: ${err instanceof Error ? err.message : String(err)}`,
      isRestUnreachable(err instanceof Error ? err.message : String(err))
        ? restUnavailableHint(baseUrl)
        : undefined
    );
    return 1;
  }

  const durationMs = Math.round(performance.now() - start);

  if (result && result.success) {
    emitOk({
      command: "send_text",
      chatId,
      result: result.message ?? "sent",
      durationMs,
    });
    return 0;
  }

  emitFail(
    "send_text",
    (result && (result.error || result.message)) || "send_text returned without success",
    await failureHintForSend(baseUrl)
  );
  return 1;
}

// ---------------------------------------------------------------------------
// send_interactive command
// ---------------------------------------------------------------------------

async function cmdSendInteractive(argv) {
  const args = parseArgs(argv);
  const start = performance.now();

  // --- validate (before any import, so failures are cheap and deterministic) ---
  const chat = parseChatId("send_interactive", args.chat);
  if (chat.code) return chat.code;
  const chatId = chat.chatId;

  // Resolve question: --question, --question-file, or piped stdin (when stdin
  // is not a TTY). Mirrors send_text's text resolution for large bodies.
  let question;
  if (typeof args.question === "string") {
    question = args.question;
  } else if (typeof args["question-file"] === "string") {
    const file = args["question-file"];
    try {
      question = file === "-" ? readStdinSync() : readFileSync(file, "utf8");
    } catch (err) {
      emitFail("send_interactive", `Cannot read --question-file ${file}: ${err.message}`);
      return 1;
    }
  } else if (!process.stdin.isTTY) {
    question = readStdinSync();
  }

  if (!question || question.trim().length === 0) {
    emitFail(
      "send_interactive",
      "Missing question content",
      "pass --question <string>, --question-file <path>, or pipe content on stdin"
    );
    return 1;
  }

  let options;
  try {
    options = parseOptions(args.options);
  } catch (err) {
    emitFail("send_interactive", err.message);
    return 1;
  }

  let actionPrompts;
  try {
    actionPrompts = parseActionPrompts(args["action-prompts"]);
  } catch (err) {
    emitFail("send_interactive", err.message);
    return 1;
  }

  const title = typeof args.title === "string" ? args.title : undefined;
  const context = typeof args.context === "string" ? args.context : undefined;
  const parentMessageId = typeof args.parent === "string" ? args.parent : undefined;

  // --- transport wiring happens ONCE in main() before dispatch (#4532); the
  //     resolved base URL is re-derived here (same flag > env > default order)
  //     purely for failure hints — no env is mutated at this point. ---
  const baseUrl = process.env.DISCLAUDE_REST_IPC_BASE_URL;

  // --- execute (stdout redirected → stderr so logger noise stays off stdout) ---
  let mod;
  try {
    mod = await withStdoutToStderr(() => import("@disclaude/mcp-server"));
  } catch (err) {
    emitFail(
      "send_interactive",
      `Failed to load @disclaude/mcp-server: ${err.message}`,
      "run inside a disclaude workspace with packages built (npm run build); the CLI reuses send_interactive from @disclaude/mcp-server"
    );
    return 1;
  }

  const sendInteractive = mod.send_interactive;
  if (typeof sendInteractive !== "function") {
    emitFail("send_interactive", "@disclaude/mcp-server does not export send_interactive (unexpected build)");
    return 1;
  }

  let result;
  try {
    result = await withStdoutToStderr(() =>
      sendInteractive({
        question,
        options,
        chatId,
        title,
        context,
        actionPrompts,
        parentMessageId,
      })
    );
  } catch (err) {
    emitFail(
      "send_interactive",
      `send_interactive threw: ${err instanceof Error ? err.message : String(err)}`,
      isRestUnreachable(err instanceof Error ? err.message : String(err))
        ? restUnavailableHint(baseUrl)
        : undefined
    );
    return 1;
  }

  const durationMs = Math.round(performance.now() - start);

  if (result && result.success) {
    emitOk({
      command: "send_interactive",
      chatId,
      result: result.message ?? "sent",
      optionCount: options.length,
      durationMs,
    });
    return 0;
  }

  emitFail(
    "send_interactive",
    (result && (result.error || result.message)) || "send_interactive returned without success",
    await failureHintForSend(baseUrl)
  );
  return 1;
}

// ---------------------------------------------------------------------------
// send_file command
// ---------------------------------------------------------------------------

async function cmdSendFile(argv) {
  const args = parseArgs(argv);
  const start = performance.now();

  // --- validate (before any import, so failures are cheap and deterministic) ---
  const chat = parseChatId("send_file", args.chat);
  if (chat.code) return chat.code;
  const chatId = chat.chatId;

  // Path presence only: existence/resolution is delegated to the first-party
  // send_file (relative paths resolve against the configured workspace dir, and
  // fs.stat there produces the authoritative error).
  const filePath = args.file;
  if (!filePath || typeof filePath !== "string") {
    emitFail("send_file", "Missing required option --file <path>", "pass --file <path> (relative paths resolve against the workspace dir)");
    return 1;
  }

  const parentMessageId = typeof args.parent === "string" ? args.parent : undefined;

  // --- transport wiring happens ONCE in main() before dispatch (#4532); the
  //     resolved base URL is re-derived here (same flag > env > default order)
  //     purely for failure hints — no env is mutated at this point. ---
  const baseUrl = process.env.DISCLAUDE_REST_IPC_BASE_URL;

  // --- execute (stdout redirected → stderr so logger noise stays off stdout) ---
  let mod;
  try {
    mod = await withStdoutToStderr(() => import("@disclaude/mcp-server"));
  } catch (err) {
    emitFail(
      "send_file",
      `Failed to load @disclaude/mcp-server: ${err.message}`,
      "run inside a disclaude workspace with packages built (npm run build); the CLI reuses send_file from @disclaude/mcp-server"
    );
    return 1;
  }

  const sendFile = mod.send_file;
  if (typeof sendFile !== "function") {
    emitFail("send_file", "@disclaude/mcp-server does not export send_file (unexpected build)");
    return 1;
  }

  let result;
  try {
    result = await withStdoutToStderr(() =>
      sendFile({ filePath, chatId, parentMessageId })
    );
  } catch (err) {
    emitFail(
      "send_file",
      `send_file threw: ${err instanceof Error ? err.message : String(err)}`,
      isRestUnreachable(err instanceof Error ? err.message : String(err))
        ? restUnavailableHint(baseUrl)
        : undefined
    );
    return 1;
  }

  const durationMs = Math.round(performance.now() - start);

  if (result && result.success) {
    emitOk({
      command: "send_file",
      chatId,
      result: result.message ?? "sent",
      fileName: result.fileName,
      fileSize: result.fileSize,
      durationMs,
    });
    return 0;
  }

  emitFail(
    "send_file",
    (result && (result.error || result.message)) || "send_file returned without success",
    await failureHintForSend(baseUrl)
  );
  return 1;
}

// ---------------------------------------------------------------------------
// send_card command
// ---------------------------------------------------------------------------

/**
 * Resolve a card JSON object from --card, --card-file, or piped stdin (mirrors
 * how cmdSendText resolves text). Inline --card for small cards; --card-file
 * (or "-") / stdin for larger card JSON, per spec §2.1 (never require the agent
 * to embed multi-KB inline). All failures here are cheap and pre-import.
 *
 * Returns { card } on success, or { error, hint? } on failure.
 */
function resolveCardJson(args) {
  let raw;
  if (typeof args.card === "string") {
    raw = args.card;
  } else if (typeof args["card-file"] === "string") {
    const file = args["card-file"];
    try {
      raw = file === "-" ? readStdinSync() : readFileSync(file, "utf8");
    } catch (err) {
      return { error: `Cannot read --card-file ${file}: ${err.message}` };
    }
  } else if (!process.stdin.isTTY) {
    // isTTY is `undefined` (not false) when stdin is a pipe/redirect.
    raw = readStdinSync();
  }

  if (!raw || raw.length === 0) {
    return {
      error: "Missing card content",
      hint: "pass --card <json>, --card-file <path>, or pipe card JSON on stdin",
    };
  }

  let card;
  try {
    card = JSON.parse(raw);
  } catch (err) {
    return { error: `Invalid card JSON: ${err.message}` };
  }

  // Mirror the channel-mcp entry handler's first guard: a Feishu card is a
  // plain object, never an array or scalar.
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    return {
      error: `Invalid card: must be an object, got ${Array.isArray(card) ? "array" : typeof card}`,
    };
  }

  return { card };
}

async function cmdSendCard(argv) {
  const args = parseArgs(argv);
  const start = performance.now();

  // --- validate (before any import, so failures are cheap and deterministic) ---
  const chat = parseChatId("send_card", args.chat);
  if (chat.code) return chat.code;
  const chatId = chat.chatId;

  const resolved = resolveCardJson(args);
  if (resolved.error) {
    emitFail("send_card", resolved.error, resolved.hint);
    return 1;
  }
  const card = resolved.card;
  const parentMessageId = typeof args.parent === "string" ? args.parent : undefined;

  // --- transport wiring happens ONCE in main() before dispatch (#4532); the
  //     resolved base URL is re-derived here (same flag > env > default order)
  //     purely for failure hints — no env is mutated at this point. The single
  //     wiring also covers resolveCardImages below — its local-image upload
  //     calls getIpcClient() internally, which selects RestIpcClient under the
  //     same env. ---
  const baseUrl = process.env.DISCLAUDE_REST_IPC_BASE_URL;

  // --- execute: replicate the channel-mcp send_card handler pipeline so the
  //     CLI reaches feature parity with the inline MCP tool — GFM-table →
  //     column_set conversion (#2340) and local-image auto-upload (#2951) live
  //     in the entry handler, not in the first-party send_card fn, so we apply
  //     them here. stdout is redirected → stderr for the import + call so pino
  //     logger noise stays off stdout. ---
  let mod;
  try {
    mod = await withStdoutToStderr(() => import("@disclaude/mcp-server"));
  } catch (err) {
    emitFail(
      "send_card",
      `Failed to load @disclaude/mcp-server: ${err.message}`,
      "run inside a disclaude workspace with packages built (npm run build); the CLI reuses send_card from @disclaude/mcp-server"
    );
    return 1;
  }

  const {
    send_card,
    isValidFeishuCard,
    getCardValidationError,
    getChatIdValidationError,
    transformCardTables,
    resolveCardImages,
    detectMarkdownTableWarnings,
  } = mod;

  if (typeof send_card !== "function") {
    emitFail("send_card", "@disclaude/mcp-server does not export send_card (unexpected build)");
    return 1;
  }
  if (
    typeof isValidFeishuCard !== "function" ||
    typeof getCardValidationError !== "function" ||
    typeof getChatIdValidationError !== "function" ||
    typeof transformCardTables !== "function" ||
    typeof resolveCardImages !== "function" ||
    typeof detectMarkdownTableWarnings !== "function"
  ) {
    emitFail(
      "send_card",
      "@disclaude/mcp-server is missing card preprocessing exports (unexpected build)",
      "run npm run build; the CLI reuses card helpers exported from @disclaude/mcp-server"
    );
    return 1;
  }

  // Card-structure validation (mirrors the handler pre-check, before any
  // transform / upload / IPC). The chatId FORMAT was already gated pre-import
  // by the twin in parseChatId above (byte-identical rules); this exported
  // helper re-runs it post-import so the two paths stay provably identical —
  // it cannot fire unless the twin and the authoritative validator disagree,
  // in which case this is the authoritative one.
  if (!isValidFeishuCard(card)) {
    emitFail("send_card", `Invalid card structure: ${getCardValidationError(card)}`);
    return 1;
  }
  const chatIdError = getChatIdValidationError(chatId);
  if (chatIdError) {
    emitFail("send_card", `Invalid chatId: ${chatIdError}`);
    return 1;
  }

  let result;
  let message;
  try {
    // #2340: GFM tables in markdown elements → column_set.
    let processedCard = transformCardTables(card);
    // #2951: auto-upload local image paths → Feishu image_keys (a no-op clone
    // when the card has no local images — no IPC, no creds needed for the walk).
    const imageResult = await resolveCardImages(processedCard);
    processedCard = imageResult.card;

    result = await withStdoutToStderr(() =>
      send_card({ card: processedCard, chatId, parentMessageId })
    );

    // #2340 / #2951: annotate the success message exactly like the handler.
    const tableWarnings = detectMarkdownTableWarnings(card);
    message = result && result.message;
    if (result && result.success) {
      if (tableWarnings.length > 0) {
        message = `${result.message}\n\nℹ️ Auto-converted ${tableWarnings.length === 1 ? "a GFM table" : `${tableWarnings.length} GFM tables`} to column_set layout. The table renders correctly now.`;
        if (imageResult.uploadedCount > 0) {
          message += `\n🖼️ Auto-uploaded ${imageResult.uploadedCount} ${imageResult.uploadedCount === 1 ? "image" : "images"}.`;
        }
      } else if (imageResult.uploadedCount > 0) {
        message = `${result.message} (${imageResult.uploadedCount} ${imageResult.uploadedCount === 1 ? "image" : "images"} auto-uploaded)`;
      } else if (imageResult.failedCount > 0) {
        message = `${result.message} (⚠️ ${imageResult.failedCount} ${imageResult.failedCount === 1 ? "image" : "images"} failed to upload)`;
      }
    }
  } catch (err) {
    emitFail(
      "send_card",
      `Card send failed: ${err instanceof Error ? err.message : String(err)}`,
      isRestUnreachable(err instanceof Error ? err.message : String(err))
        ? restUnavailableHint(baseUrl)
        : undefined
    );
    return 1;
  }

  const durationMs = Math.round(performance.now() - start);

  if (result && result.success) {
    emitOk({
      command: "send_card",
      chatId,
      result: message ?? "sent",
      durationMs,
    });
    return 0;
  }

  emitFail(
    "send_card",
    (result && (result.error || result.message)) || "send_card returned without success",
    await failureHintForSend(baseUrl)
  );
  return 1;
}

// ---------------------------------------------------------------------------
// push_to_agent command (part 6 of #4459)
//
// Mirrors cmdSendText: push_to_agent is a simple { chatId, message } send whose
// MCP entry handler is the bare first-party function (no card/table/image
// transforms), so the CLI calls push_to_agent() directly with no extra helpers.
// The message body accepts --message, --message-file, or piped stdin, exactly as
// send_text accepts --text/--text-file/stdin — per spec §2.1 (never require the
// agent to embed a multi-KB instruction inline).
// ---------------------------------------------------------------------------

async function cmdPushToAgent(argv) {
  const args = parseArgs(argv);
  const start = performance.now();

  // --- validate (before any import, so failures are cheap and deterministic) ---
  const chat = parseChatId("push_to_agent", args.chat);
  if (chat.code) return chat.code;
  const chatId = chat.chatId;

  // Resolve message: --message, --message-file, or piped stdin (when not a TTY).
  let message;
  if (typeof args.message === "string") {
    message = args.message;
  } else if (typeof args["message-file"] === "string") {
    const file = args["message-file"];
    try {
      message = file === "-" ? readStdinSync() : readFileSync(file, "utf8");
    } catch (err) {
      emitFail("push_to_agent", `Cannot read --message-file ${file}: ${err.message}`);
      return 1;
    }
  } else if (!process.stdin.isTTY) {
    message = readStdinSync();
  }

  if (!message || message.length === 0) {
    emitFail(
      "push_to_agent",
      "Missing message content",
      "pass --message <string>, --message-file <path>, or pipe content on stdin"
    );
    return 1;
  }

  // --- transport wiring happens ONCE in main() before dispatch (#4532); the
  //     resolved base URL is re-derived here (same flag > env > default order)
  //     purely for failure hints — no env is mutated at this point. ---
  const baseUrl = process.env.DISCLAUDE_REST_IPC_BASE_URL;

  // --- execute (stdout redirected → stderr so logger noise stays off stdout) ---
  let mod;
  try {
    mod = await withStdoutToStderr(() => import("@disclaude/mcp-server"));
  } catch (err) {
    emitFail(
      "push_to_agent",
      `Failed to load @disclaude/mcp-server: ${err.message}`,
      "run inside a disclaude workspace with packages built (npm run build); the CLI reuses push_to_agent from @disclaude/mcp-server"
    );
    return 1;
  }

  const pushToAgent = mod.push_to_agent;
  if (typeof pushToAgent !== "function") {
    emitFail("push_to_agent", "@disclaude/mcp-server does not export push_to_agent (unexpected build)");
    return 1;
  }

  let result;
  try {
    result = await withStdoutToStderr(() => pushToAgent({ chatId, message }));
  } catch (err) {
    emitFail(
      "push_to_agent",
      `push_to_agent threw: ${err instanceof Error ? err.message : String(err)}`,
      isRestUnreachable(err instanceof Error ? err.message : String(err))
        ? restUnavailableHint(baseUrl)
        : undefined
    );
    return 1;
  }

  const durationMs = Math.round(performance.now() - start);

  if (result && result.success) {
    emitOk({
      command: "push_to_agent",
      chatId,
      result: result.message ?? "pushed",
      durationMs,
    });
    return 0;
  }

  emitFail(
    "push_to_agent",
    (result && (result.error || result.message)) || "push_to_agent returned without success",
    await failureHintForSend(baseUrl)
  );
  return 1;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(argv) {
  const subcommand = argv[0];

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(HELP + "\n");
    return 0;
  }

  // --- transport wiring (#4532): force REST ONCE, before any command dispatch
  //     and thus before any `@disclaude/mcp-server` import. Every subcommand —
  //     current and future — inherits the REST selection by construction; the
  //     env vars are written before the first import so `getIpcClient()` and
  //     `isIpcAvailable()` both see them. ---
  wireRestTransport(parseArgs(argv.slice(1)));

  if (subcommand === "send_text") {
    return cmdSendText(argv.slice(1));
  }

  if (subcommand === "send_interactive") {
    return cmdSendInteractive(argv.slice(1));
  }

  if (subcommand === "send_file") {
    return cmdSendFile(argv.slice(1));
  }

  if (subcommand === "send_card") {
    return cmdSendCard(argv.slice(1));
  }

  if (subcommand === "push_to_agent") {
    return cmdPushToAgent(argv.slice(1));
  }

  process.stdout.write(HELP + "\n");
  process.stderr.write(`\nUnknown command: ${subcommand}\n`);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => exitWithCode(code))
  .catch((err) => {
    // Last-resort guard: never let an unexpected error write a stack trace to
    // stdout. The emit* no-op guard above keeps this to exactly one JSON line
    // even if a pino teardown throw lands here after a valid result.
    process.stderr.write(`${COMMAND} CLI crashed: ${err.stack || err}\n`);
    emitFail("channel", `CLI crashed: ${err instanceof Error ? err.message : String(err)}`);
    exitWithCode(1);
  });
