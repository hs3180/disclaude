#!/usr/bin/env node
/**
 * channel Skill — CLI helper (Issue #4459, parts 3–4, 6–7)
 *
 * CLI-Skill replacement for the inline `channel-mcp` MCP server
 * (`packages/mcp-server/src/channel-mcp.ts`, surface S1 in
 * `docs/mcp-server-inventory.md`). Part of the "reduce MCP" direction
 * (#4383, owner decision 2026-08-07): disclaude unifies both backends on the
 * Skills (CLI + README) model defined in `docs/skill-format-spec.md`.
 *
 * What this implements — the `send_text` (part 3), `send_file` (part 4),
 * `push_to_agent` (part 6), and `send_interactive` (part 7) subcommands:
 *   The agent shells out via Bash instead of calling the in-process MCP tool.
 *   The CLI reuses the SAME first-party implementations (`send_text` /
 *   `send_file` / `push_to_agent` / `send_interactive` from
 *   `@disclaude/mcp-server`) — it does not re-implement the Feishu send path.
 *   All four reach the PrimaryNode over IPC
 *   (`getIpcClient()`), so this CLI is a one-shot process per call that
 *   connects, sends, and exits — the same transport the standalone
 *   `disclaude-mcp` server (S3) already uses from a separate process. No
 *   long-lived session is required per call.
 *   `send_file` uploads via IPC to the PrimaryNode; relative paths are resolved
 *   against the configured workspace dir by the first-party impl (file
 *   existence is NOT pre-validated here for that reason).
 *   `push_to_agent` follows the exact same shape as `send_text` (it is a simple
 *   { chatId, message } send whose MCP entry handler is the bare first-party
 *   function — no card/table/image transforms, so no extra helper exports are
 *   needed; see README §Parity).
 *
 *   `send_interactive` (part 7) forwards the RAW parameters (question, options,
 *   title, context, actionPrompts) to the PrimaryNode via the `sendInteractive`
 *   IPC; the PrimaryNode builds the interactive card, sends it, and registers
 *   the button-click action prompts (#1571/#1572). Button handling lives on the
 *   PrimaryNode side — this CLI is a one-shot *client*, exactly like `send_text`,
 *   NOT the IPC server / button handler.
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
 *   • the remaining channel tool (send_card) — it follows the same pattern
 *     as a subcommand here.
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
 *   node skills/channel/cli.mjs send_file --chat oc_xxx --file ./report.pdf
 *   node skills/channel/cli.mjs push_to_agent --chat oc_xxx --message "Summarize the thread"
 *
 * Parts 3 + 4 + 6 + 7 of #4459 — does not auto-close the parent issue.
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
  push_to_agent    Push an instruction to the chat agent for a chat, creating
                   the agent lazily if needed (part 6).
  send_interactive Send an interactive card with clickable buttons (part 7).
                   The remaining channel tool — send_card — is deferred to a
                   later part of #4459.
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
  node skills/channel/cli.mjs send_file --chat oc_abc --file ./report.pdf
  node skills/channel/cli.mjs send_file --chat oc_abc --file ./log.txt --parent om_parent
  node skills/channel/cli.mjs push_to_agent --chat oc_abc --message "Summarize unread messages"
  echo "long instruction" | node skills/channel/cli.mjs push_to_agent --chat oc_abc
  node skills/channel/cli.mjs send_interactive --chat oc_abc \\
    --question "Which option do you prefer?" \\
    --options '[{"text":"Approve","value":"approve","type":"primary"},
                {"text":"Reject","value":"reject","type":"danger"}]' \\
    --title "Code Review"
  echo "Deploy to prod?" | node skills/channel/cli.mjs send_interactive --chat oc_abc \\
    --options '[{"text":"yes","value":"yes"},{"text":"no","value":"no"}]' \\
    --action-prompts '{"yes":"[user] approved deploy","no":"[user] rejected deploy"}'

Version ${VERSION} — parts 3, 4, 6 + 7 of #4459. This Skill does not auto-close the parent issue.`;

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
// send_interactive command
// ---------------------------------------------------------------------------

async function cmdSendInteractive(argv) {
  const args = parseArgs(argv);
  const start = performance.now();

  // --- validate (before any import, so failures are cheap and deterministic) ---
  const chatId = args.chat;
  if (!chatId || typeof chatId !== "string") {
    emitFail("send_interactive", "Missing required option --chat <id>", "pass --chat oc_xxx");
    return 1;
  }

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
      `send_interactive threw: ${err instanceof Error ? err.message : String(err)}`
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
    result && /IPC|PrimaryNode/i.test(result.message || result.error || "")
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
    result && /IPC|PrimaryNode/i.test(result.message || result.error || "")
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

  if (subcommand === "send_interactive") {
    return cmdSendInteractive(argv.slice(1));
  }

  if (subcommand === "send_file") {
    return cmdSendFile(argv.slice(1));
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
