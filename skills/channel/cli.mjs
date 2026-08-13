#!/usr/bin/env node
/**
 * channel Skill — CLI helper (Issue #4459, part 3)
 *
 * CLI-Skill replacement for the inline `channel-mcp` MCP server
 * (`packages/mcp-server/src/channel-mcp.ts`, surface S1 in
 * `docs/mcp-server-inventory.md`). Part of the "reduce MCP" direction
 * (#4383, owner decision 2026-08-07): disclaude unifies both backends on the
 * Skills (CLI + README) model defined in `docs/skill-format-spec.md`.
 *
 * What this part implements — the `send_text` (part 3) and `push_to_agent`
 * (part 6) subcommands:
 *   The agent shells out via Bash instead of calling the in-process MCP tool.
 *   The CLI reuses the SAME first-party implementations (`send_text` and
 *   `push_to_agent` from `@disclaude/mcp-server`) — it does not re-implement the
 *   Feishu send path. Both reach the PrimaryNode over IPC (`getIpcClient()`), so
 *   this CLI is a one-shot process per call that connects, sends, and exits — the
 *   same transport the standalone `disclaude-mcp` server (S3) already uses from a
 *   separate process. No long-lived session is required for a single send.
 *   `push_to_agent` follows the exact same shape as `send_text` (it is a simple
 *   { chatId, message } send whose MCP entry handler is the bare first-party
 *   function — no card/table/image transforms, so no extra helper exports are
 *   needed; see README §Parity).
 *
 * Output contract — exactly ONE JSON object on stdout (see spec §2.2):
 *   success: { ok: true,  command: "send_text", chatId, result, durationMs }
 *   failure: { ok: false, command: "send_text", error, hint? }   (exit code 1)
 * The agent parses stdout JSON; stderr is for diagnostics only. The pino logger
 * used inside `send_text` writes to stdout by default, so this CLI temporarily
 * redirects stdout → stderr for the duration of the IPC call to keep the result
 * object the only thing on stdout.
 *
 * Deferred (later parts of #4459) — out of scope here:
 *   • the other 3 channel tools (send_card, send_interactive, send_file) — they
 *     follow the same pattern as subcommands here. (`push_to_agent`, part 6, is
 *     added in this branch.)
 *   • live end-to-end parity verification against the MCP tool (requires a
 *     running PrimaryNode + Feishu credentials); this part verifies the CLI
 *     command surface, output contract, validation, and graceful-degradation
 *     paths only — mirroring how #4464 part 1 deferred live-browser parity.
 *   • per-chat capability gating parity (the MCP layer gates on
 *     `supportedMcpTools`; a CLI is invoked at the agent's discretion) — see
 *     README §Parity.
 *
 * Usage:
 *   node skills/channel/cli.mjs --help
 *   node skills/channel/cli.mjs send_text --chat oc_xxx --text "Hello"
 *   echo "long body" | node skills/channel/cli.mjs send_text --chat oc_xxx
 *   node skills/channel/cli.mjs push_to_agent --chat oc_xxx --message "Summarize the thread"
 *
 * Part 3 (+ part 6: push_to_agent) of #4459 — does not auto-close the parent issue.
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
  send_text       Send a plain text message to a chat (part 3).
  push_to_agent   Push an instruction to the chat agent for a chat, creating the
                  agent lazily if needed (part 6). The other 3 channel tools
                  (send_card, send_interactive, send_file) are deferred to later
                  parts of #4459.
  help            Show this help message.

send_text options:
  --chat <id>          Target chat ID (e.g. oc_xxx). Required.
  --text <string>      Text content. Required unless --text-file or stdin is used.
  --text-file <path>   Read text content from a file (use "-" for stdin explicitly).
  --parent <id>        Optional parent message ID (thread reply).
  --mentions <json>    Optional JSON array of { "openId": string, "name"?: string }.
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
    {"ok":false,"command":"send_text","error":"...","hint":"..."}
    {"ok":true,"command":"push_to_agent","chatId":"oc_xxx","result":"...","durationMs":12}

Runtime:
  Reuses send_text from @disclaude/mcp-server, which needs a running disclaude
  PrimaryNode (IPC) and Feishu credentials. Run inside a disclaude workspace
  where the packages are built.

Examples:
  node skills/channel/cli.mjs send_text --chat oc_abc --text "Hello, world!"
  echo "status: ok" | node skills/channel/cli.mjs send_text --chat oc_abc
  node skills/channel/cli.mjs send_text --chat oc_abc --text-file ./msg.txt --parent om_parent
  node skills/channel/cli.mjs send_text --chat oc_abc --text "@owner pls review" \\
    --mentions '[{"openId":"ou_xxx","name":"owner"}]'
  node skills/channel/cli.mjs push_to_agent --chat oc_abc --message "Summarize unread messages"
  echo "long instruction" | node skills/channel/cli.mjs push_to_agent --chat oc_abc

Version ${VERSION} — parts 3 + 6 of #4459. This Skill does not auto-close the parent issue.`;

// ---------------------------------------------------------------------------
// Output helpers — every command result is ONE JSON object on stdout.
// ---------------------------------------------------------------------------

function emitOk(payload) {
  process.stdout.write(JSON.stringify({ ok: true, ...payload }) + "\n");
}

function emitFail(command, error, hint) {
  const body = { ok: false, command, error };
  if (hint) body.hint = hint;
  process.stdout.write(JSON.stringify(body) + "\n");
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
  const chatId = args.chat;
  if (!chatId || typeof chatId !== "string") {
    emitFail("push_to_agent", "Missing required option --chat <id>", "pass --chat oc_xxx");
    return 1;
  }

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
      `push_to_agent threw: ${err instanceof Error ? err.message : String(err)}`
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

  if (subcommand === "push_to_agent") {
    return cmdPushToAgent(argv.slice(1));
  }

  process.stdout.write(HELP + "\n");
  process.stderr.write(`\nUnknown command: ${subcommand}\n`);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    // Last-resort guard: never let an unexpected error write a stack trace to
    // stdout. Emit a single failure JSON instead.
    process.stderr.write(`${COMMAND} CLI crashed: ${err.stack || err}\n`);
    emitFail("channel", `CLI crashed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
