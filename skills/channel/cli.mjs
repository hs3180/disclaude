#!/usr/bin/env node
/**
 * channel Skill — CLI helper (Issue #4459, parts 3–5)
 *
 * CLI-Skill replacement for the inline `channel-mcp` MCP server
 * (`packages/mcp-server/src/channel-mcp.ts`, surface S1 in
 * `docs/mcp-server-inventory.md`). Part of the "reduce MCP" direction
 * (#4383, owner decision 2026-08-07): disclaude unifies both backends on the
 * Skills (CLI + README) model defined in `docs/skill-format-spec.md`.
 *
 * Subcommands implemented so far:
 *   • send_text  (part 3, PR #4467)
 *   • send_file  (part 4, PR #4494)
 *   • send_card  (part 5, this change)
 * Each reuses the SAME first-party implementation from `@disclaude/mcp-server`
 * — the CLI does not re-implement the Feishu send path. All reach the
 * PrimaryNode over IPC (`getIpcClient()`), so this CLI is a one-shot process
 * per call that connects, sends, and exits — the same transport the standalone
 * `disclaude-mcp` server (S3) already uses from a separate process. No
 * long-lived session is required for a single send.
 *
 * send_card parity note: the first-party `send_card` fn does NOT apply the
 * GFM-table conversion (#2340) or local-image auto-upload (#2951) — those live
 * in the channel-mcp ENTRY handler. So `cmdSendCard` replicates that handler's
 * pipeline (validate → transformCardTables → resolveCardImages → send_card →
 * annotate) using helpers now exported from `@disclaude/mcp-server`, so the CLI
 * matches the inline MCP tool instead of silently dropping those features.
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
 * Deferred (later parts of #4459) — out of scope here:
 *   • the remaining 2 channel tools (send_interactive, push_to_agent) — they
 *     follow the same pattern as subcommands here.
 *   • live end-to-end parity verification against the MCP tool (requires a
 *     running PrimaryNode + Feishu credentials); this CLI verifies the command
 *     surface, output contract, validation, and graceful-degradation paths
 *     only — mirroring how #4464 part 1 deferred live-browser parity.
 *   • per-chat capability gating parity (the MCP layer gates on
 *     `supportedMcpTools`; a CLI is invoked at the agent's discretion) — see
 *     README §Parity.
 *
 * Usage:
 *   node skills/channel/cli.mjs --help
 *   node skills/channel/cli.mjs send_text --chat oc_xxx --text "Hello"
 *   echo "long body" | node skills/channel/cli.mjs send_text --chat oc_xxx
 *   node skills/channel/cli.mjs send_file --chat oc_xxx --file ./report.pdf
 *   node skills/channel/cli.mjs send_card --chat oc_xxx --card-file ./card.json
 *
 * Parts 3–5 of #4459 — does not auto-close the parent issue.
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
  send_text   Send a plain text message to a chat (part 3).
  send_file   Send a file to a chat (part 4).
  send_card   Send a display-only Feishu card (part 5). GFM tables in markdown
              elements are auto-converted to column_set; local image paths are
              auto-uploaded — feature parity with the MCP tool.
  help        Show this help message.

  (send_interactive / push_to_agent are deferred to later parts of #4459.)

send_text options:
  --chat <id>          Target chat ID (e.g. oc_xxx). Required.
  --text <string>      Text content. Required unless --text-file or stdin is used.
  --text-file <path>   Read text content from a file (use "-" for stdin explicitly).
  --parent <id>        Optional parent message ID (thread reply).
  --mentions <json>    Optional JSON array of { "openId": string, "name"?: string }.
  --help, -h           Show this help message.

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

Output:
  Exactly one JSON object on stdout (exit 0 on success, 1 on failure):
    {"ok":true,"command":"send_text","chatId":"oc_xxx","result":"...","durationMs":12}
    {"ok":true,"command":"send_card","chatId":"oc_xxx","result":"...","durationMs":42}
    {"ok":false,"command":"send_card","error":"...","hint":"..."}

Runtime:
  Reuses send_text / send_file / send_card (and card preprocessing helpers) from
  @disclaude/mcp-server, which needs a running disclaude PrimaryNode (IPC) and
  Feishu credentials. Run inside a disclaude workspace where the packages are built.

Examples:
  node skills/channel/cli.mjs send_text --chat oc_abc --text "Hello, world!"
  echo "status: ok" | node skills/channel/cli.mjs send_text --chat oc_abc
  node skills/channel/cli.mjs send_text --chat oc_abc --text-file ./msg.txt --parent om_parent
  node skills/channel/cli.mjs send_text --chat oc_abc --text "@owner pls review" \\
    --mentions '[{"openId":"ou_xxx","name":"owner"}]'
  node skills/channel/cli.mjs send_file --chat oc_abc --file ./report.pdf
  node skills/channel/cli.mjs send_file --chat oc_abc --file ./log.txt --parent om_parent
  node skills/channel/cli.mjs send_card --chat oc_abc --card-file ./card.json
  echo '{"elements":[{"tag":"markdown","content":"hi"}]}' \\
    | node skills/channel/cli.mjs send_card --chat oc_abc

Version ${VERSION} — parts 3–5 of #4459. This Skill does not auto-close the parent issue.`;

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
// Argument parsing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// send_text command
// ---------------------------------------------------------------------------

async function cmdSendText(argv) {
  const args = parseArgs(argv);
  const start = performance.now();

  // --- validate (before any import, so failures are cheap and deterministic) ---
  const chatId = args.chat;
  if (!chatId || typeof chatId !== "string") {
    emitFail("send_text", "Missing required option --chat <id>", "pass --chat oc_xxx");
    return 1;
  }

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
      `send_text threw: ${err instanceof Error ? err.message : String(err)}`
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
    result && /IPC|PrimaryNode/i.test(result.message || "")
      ? "ensure the disclaude PrimaryNode is running and IPC is reachable"
      : undefined
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
  const chatId = args.chat;
  if (!chatId || typeof chatId !== "string") {
    emitFail("send_file", "Missing required option --chat <id>", "pass --chat oc_xxx");
    return 1;
  }

  // Path presence only: existence/resolution is delegated to the first-party
  // send_file (relative paths resolve against the configured workspace dir, and
  // fs.stat there produces the authoritative error).
  const filePath = args.file;
  if (!filePath || typeof filePath !== "string") {
    emitFail("send_file", "Missing required option --file <path>", "pass --file <path> (relative paths resolve against the workspace dir)");
    return 1;
  }

  const parentMessageId = typeof args.parent === "string" ? args.parent : undefined;

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
      `send_file threw: ${err instanceof Error ? err.message : String(err)}`
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
    result && /IPC|PrimaryNode/i.test(result.message || result.error || "")
      ? "ensure the disclaude PrimaryNode is running and IPC is reachable"
      : undefined
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
  const chatId = args.chat;
  if (!chatId || typeof chatId !== "string") {
    emitFail("send_card", "Missing required option --chat <id>", "pass --chat oc_xxx");
    return 1;
  }

  const resolved = resolveCardJson(args);
  if (resolved.error) {
    emitFail("send_card", resolved.error, resolved.hint);
    return 1;
  }
  const card = resolved.card;
  const parentMessageId = typeof args.parent === "string" ? args.parent : undefined;

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

  // Card-structure + chatId-format validation (mirrors the handler pre-checks,
  // before any transform / upload / IPC).
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
      `Card send failed: ${err instanceof Error ? err.message : String(err)}`
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
    result && /IPC|PrimaryNode/i.test(result.message || "")
      ? "ensure the disclaude PrimaryNode is running and IPC is reachable"
      : undefined
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

  if (subcommand === "send_text") {
    return cmdSendText(argv.slice(1));
  }

  if (subcommand === "send_file") {
    return cmdSendFile(argv.slice(1));
  }

  if (subcommand === "send_card") {
    return cmdSendCard(argv.slice(1));
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
