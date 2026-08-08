#!/usr/bin/env node
/**
 * Playwright Skill — CLI helper (Issue #4460, part 1)
 *
 * Replaces the Playwright MCP server (`@playwright/mcp`, `mcp__playwright__*` tools)
 * with a plain CLI the agent drives via Bash, matching disclaude's "reduce MCP /
 * Skills = CLI + README" direction (see #4459 / #4460).
 *
 * Design model — CLI vs MCP session:
 *   The Playwright MCP keeps ONE long-lived browser across tool calls. A CLI is a
 *   fresh process per invocation, so we can't keep a browser open between calls.
 *   Instead this CLI offers:
 *     • one-shot commands  — launch → act → close, fully self-contained
 *         (screenshot / snapshot / extract / eval <url>)
 *     • `script` command   — run many steps (nav/click/type/...) inside ONE browser
 *         session, returning per-step results. This is the workhorse for real
 *         multi-step automation (the MCP-session equivalent).
 *   Cross-run state (cookies / localStorage) is carried via Playwright
 *   `storageState` on disk (--session <file>), not a live browser.
 *
 * Output contract — every command prints ONE JSON object to stdout:
 *   success: { ok: true, command, ...result, durationMs }
 *   failure: { ok: false, command, error, hint? }   (exit code 1)
 * The agent parses stdout JSON; stderr is for human-readable diagnostics only.
 *
 * Runtime requirement — needs the `playwright` package + browser binaries:
 *     npm install playwright && npx playwright install chromium
 * If `playwright` is missing, browser commands print a clear install hint instead
 * of crashing. Commands that need no browser (--help, session path) always work.
 *
 * Usage:
 *   node cli.mjs --help
 *   node cli.mjs screenshot https://example.com --out shot.png
 *   node cli.mjs snapshot https://example.com --out snap.json
 *   node cli.mjs script --steps '[{"action":"nav","url":"https://example.com"},{"action":"click","selector":"a.login"},{"action":"screenshot","out":"after.png"}]'
 *
 * Part 1 of #4460 — covers scope 2 (CLI command surface) + scope 3 (artifact
 * contract). Live browser parity verification (scope 5) and removal of the
 * `@playwright/mcp` dependency (scope 6) are deferred to part 2.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { performance } from "node:perf_hooks";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BROWSER = process.env.PLAYWRIGHT_SKILL_BROWSER || "chromium"; // chromium|firefox|webkit
const HEADLESS = process.env.PLAYWRIGHT_SKILL_HEADLESS !== "0"; // default headless
const ARTIFACT_DIR = process.env.PLAYWRIGHT_SKILL_DIR || ".playwright-skill";
const VERSION = "0.1.0";

const VALID_BROWSERS = new Set(["chromium", "firefox", "webkit"]);
const VALID_STEP_ACTIONS = new Set([
  "nav",
  "click",
  "type",
  "fill",
  "select",
  "hover",
  "press",
  "screenshot",
  "snapshot",
  "extract",
  "eval",
  "wait",
  "back",
  "forward",
]);

// ---------------------------------------------------------------------------
// Pure helpers (no browser — unit-verifiable)
// ---------------------------------------------------------------------------

/** Build the --help text. Pure. */
function helpText() {
  return `Playwright Skill CLI v${VERSION} — browser automation via CLI (Issue #4460).

USAGE
  node cli.mjs <command> [options]

ONE-SHOT COMMANDS (launch -> act -> close; self-contained)
  screenshot <url> [--out PATH] [--full] [--wait MS|SEL] [--session FILE]
  snapshot   <url> [--out PATH] [--wait MS|SEL]    [--session FILE]
  extract    <url> <selector> [--attr NAME]        [--session FILE]
  eval       <url> <js-expression>                 [--session FILE]

MULTI-STEP COMMAND (one browser session, many steps)
  script --steps '<JSON>'|@FILE [--session FILE] [--out PATH]
    step shape: { "action": "nav|click|type|fill|select|hover|press|
                            screenshot|snapshot|extract|eval|wait|back|forward",
                  ...action-specific fields }

OTHER
  session-path            print the resolved artifact directory (no browser)
  --help, -h              show this help
  --version, -v           print version

STEP / ONE-SHOT FIELDS
  url                 navigate target (nav / one-shot commands)
  selector            CSS (or Playwright) selector (click / type / extract ...)
  text                text to type (type)
  fields              [{selector,type,value}] (fill)
  values              [string] (select)
  key                 key name, e.g. Enter (press)
  expr                JS expression to evaluate (eval)
  out                 artifact path (screenshot/snapshot). default under ${ARTIFACT_DIR}/
  full                true = full-page screenshot
  wait                MS (number) | selector (string) waited before acting
  attr                attribute name (extract; default = textContent)

ENV
  PLAYWRIGHT_SKILL_BROWSER   chromium|firefox|webkit (default chromium)
  PLAYWRIGHT_SKILL_HEADLESS  "0" to run headed (default headless)
  PLAYWRIGHT_SKILL_DIR       artifact dir (default ${ARTIFACT_DIR})

RUNTIME
  Needs \`playwright\` + browser binaries:
    npm install playwright && npx playwright install chromium

OUTPUT
  One JSON object on stdout: { ok, command, ...result, durationMs } or
  { ok:false, command, error, hint? }. Exit code 1 on failure.`;
}

/** Resolve an artifact path: explicit --out wins, else <dir>/<prefix>-<ts>.<ext>. Pure. */
function resolveArtifactPath(explicitOut, prefix, ext, dir = ARTIFACT_DIR) {
  if (explicitOut) return resolve(explicitOut);
  // Timestamp injected by caller via stamp option to stay pure/testable.
  return join(dir, `${prefix}.${ext}`);
}

/** Format a success result envelope. Pure. */
function ok(command, result, startedAt) {
  return { ok: true, command, ...result, durationMs: Math.round(performance.now() - startedAt) };
}

/** Format a failure result envelope. Pure. */
function fail(command, error, hint) {
  const env = { ok: false, command, error };
  if (hint) env.hint = hint;
  return env;
}

/** Validate a parsed script step. Returns error string or null. Pure. */
function validateStep(step, index) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    return `step[${index}] must be an object`;
  }
  if (!step.action || !VALID_STEP_ACTIONS.has(step.action)) {
    return `step[${index}].action "${step.action}" is not one of: ${[...VALID_STEP_ACTIONS].join(", ")}`;
  }
  switch (step.action) {
    case "nav":
      if (!step.url) return `step[${index}] (nav) requires "url"`;
      break;
    case "click":
    case "hover":
    case "extract":
      if (!step.selector) return `step[${index}] (${step.action}) requires "selector"`;
      break;
    case "type":
      // NOTE: `type` needs both selector and text. This must be its own case — a
      // shared `case "type":` fall-through above would shadow this block (duplicate
      // case labels are dead code in JS), silently dropping the text requirement.
      if (!step.selector) return `step[${index}] (type) requires "selector"`;
      if (step.text === undefined) return `step[${index}] (type) requires "text"`;
      break;
    case "select":
      if (!step.selector) return `step[${index}] (select) requires "selector"`;
      if (!Array.isArray(step.values)) return `step[${index}] (select) requires "values" array`;
      break;
    case "press":
      if (!step.key) return `step[${index}] (press) requires "key"`;
      break;
    case "eval":
      if (!step.expr) return `step[${index}] (eval) requires "expr"`;
      break;
    case "fill":
      if (!Array.isArray(step.fields)) return `step[${index}] (fill) requires "fields" array`;
      break;
    // screenshot / snapshot / wait / back / forward have no required fields
  }
  return null;
}

/** Parse argv into { command, args, opts }. Pure (no side effects). */
function parseArgs(argv) {
  const positional = [];
  const opts = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { command: "help" };
    if (a === "--version" || a === "-v") return { command: "version" };
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      // boolean flags
      if (key === "full") {
        opts.full = true;
        i += 1;
        continue;
      }
      if (next === undefined || next.startsWith("--")) {
        opts[key] = true;
        i += 1;
      } else {
        opts[key] = next;
        i += 2;
      }
    } else {
      positional.push(a);
      i += 1;
    }
  }
  const command = positional[0];
  return { command, positionals: positional.slice(1), opts };
}

// ---------------------------------------------------------------------------
// Browser layer (needs `playwright`)
// ---------------------------------------------------------------------------

/** Dynamically import playwright; throw a friendly error if absent. */
async function importPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error(
      "playwright is not installed. Install it with:\n" +
        "  npm install playwright && npx playwright install chromium",
    );
  }
}

let _browserNameCache = null;
function assertBrowser() {
  if (_browserNameCache) return _browserNameCache;
  if (!VALID_BROWSERS.has(BROWSER)) {
    throw new Error(
      `PLAYWRIGHT_SKILL_BROWSER="${BROWSER}" invalid; expected one of: ${[...VALID_BROWSERS].join(", ")}`,
    );
  }
  _browserNameCache = BROWSER;
  return _browserNameCache;
}

async function launchSession({ sessionFile } = {}) {
  const pw = await importPlaywright();
  const browserName = assertBrowser();
  const browser = await pw[browserName].launch({ headless: HEADLESS });
  const contextOpts = {};
  if (sessionFile && existsSync(resolve(sessionFile))) {
    contextOpts.storageState = resolve(sessionFile);
  }
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();
  return { pw, browser, context, page };
}

async function closeSession({ browser, context, sessionFile }) {
  let savedSession = null;
  if (sessionFile) {
    try {
      const state = await context.storageState();
      mkdirSync(dirname(resolve(sessionFile)), { recursive: true });
      writeFileSync(resolve(sessionFile), JSON.stringify(state, null, 2));
      savedSession = resolve(sessionFile);
    } catch {
      /* storageState best-effort; ignore failures */
    }
  }
  try {
    await context.close();
  } catch {
    /* ignore */
  }
  try {
    await browser.close();
  } catch {
    /* ignore */
  }
  return savedSession;
}

async function applyWait(page, wait) {
  if (wait === undefined || wait === null || wait === "") return;
  const n = Number(wait);
  if (!Number.isNaN(n)) {
    await page.waitForTimeout(n);
  } else {
    await page.waitForSelector(String(wait), { timeout: 30000 });
  }
}

// Execute a single validated step against an open page. Returns a result fragment.
async function execStep(page, step, index, dir) {
  const label = `step[${index}](${step.action})`;
  if (step.wait) await applyWait(page, step.wait);
  switch (step.action) {
    case "nav": {
      const resp = await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return { action: "nav", url: step.url, status: resp ? resp.status() : null, title: await page.title() };
    }
    case "back":
      await page.goBack();
      return { action: "back", title: await page.title() };
    case "forward":
      await page.goForward();
      return { action: "forward", title: await page.title() };
    case "click":
      await page.click(step.selector, { timeout: step.timeout ?? 30000 });
      return { action: "click", selector: step.selector };
    case "hover":
      await page.hover(step.selector, { timeout: step.timeout ?? 30000 });
      return { action: "hover", selector: step.selector };
    case "type":
      await page.fill(step.selector, String(step.text ?? ""), { timeout: step.timeout ?? 30000 });
      if (step.submit) await page.press(step.selector, "Enter");
      return { action: "type", selector: step.selector, submit: !!step.submit };
    case "fill": {
      const filled = [];
      for (const f of step.fields) {
        await page.fill(f.selector, String(f.value));
        filled.push(f.selector);
      }
      return { action: "fill", selectors: filled };
    }
    case "select": {
      const selected = await page.selectOption(step.selector, step.values);
      return { action: "select", selector: step.selector, selected };
    }
    case "press":
      await page.keyboard.press(step.key);
      return { action: "press", key: step.key };
    case "wait":
      await applyWait(page, step.duration ?? step.wait ?? step.ms);
      return { action: "wait" };
    case "eval": {
      const value = await page.evaluate(step.expr);
      return { action: "eval", value };
    }
    case "extract": {
      const value = await page.locator(step.selector).first().textContent();
      return { action: "extract", selector: step.selector, value: (value ?? "").trim() };
    }
    case "screenshot": {
      const out = resolveArtifactPath(step.out, `step-${index}-screenshot`, "png", dir);
      mkdirSync(dirname(out), { recursive: true });
      await page.screenshot({ path: out, fullPage: !!step.full });
      return { action: "screenshot", artifact: out };
    }
    case "snapshot": {
      const snap = await page.accessibility.snapshot();
      const out = resolveArtifactPath(step.out, `step-${index}-snapshot`, "json", dir);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(snap, null, 2));
      return { action: "snapshot", artifact: out };
    }
    default:
      throw new Error(`${label}: unhandled action`);
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdScript({ opts }) {
  if (!opts.steps) {
    throw new Error("script requires --steps '<JSON>' or --steps @file");
  }
  let raw = opts.steps;
  if (raw.startsWith("@")) {
    raw = await import("node:fs").then((fs) => fs.readFileSync(raw.slice(1), "utf8"));
  }
  let steps;
  try {
    steps = JSON.parse(raw);
  } catch (e) {
    throw new Error(`--steps is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("--steps must be a non-empty JSON array of step objects");
  }
  for (let i = 0; i < steps.length; i++) {
    const err = validateStep(steps[i], i);
    if (err) throw new Error(err);
  }
  const session = await launchSession({ sessionFile: opts.session });
  const results = [];
  let savedSession = null;
  try {
    for (let i = 0; i < steps.length; i++) {
      results.push(await execStep(session.page, steps[i], i, ARTIFACT_DIR));
    }
  } finally {
    // closeSession must always run, but the return MUST NOT live in `finally`:
    // a `return` here would swallow any exception thrown by execStep above,
    // turning a mid-script step failure into a silent {ok:true, steps:[...]}.
    savedSession = await closeSession({ ...session, sessionFile: opts.session });
  }
  return { steps: results, ...(savedSession ? { sessionSaved: savedSession } : {}) };
}

async function cmdOneShot(action, positionals, opts) {
  const url = positionals[0];
  if (!url) throw new Error(`${action} requires a <url> argument`);
  const session = await launchSession({ sessionFile: opts.session });
  try {
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    if (opts.wait) await applyWait(session.page, opts.wait);
    if (action === "screenshot") {
      const out = resolveArtifactPath(opts.out, "screenshot", "png");
      mkdirSync(dirname(out), { recursive: true });
      await session.page.screenshot({ path: out, fullPage: !!opts.full });
      return { url, artifact: out };
    }
    if (action === "snapshot") {
      const snap = await session.page.accessibility.snapshot();
      const out = resolveArtifactPath(opts.out, "snapshot", "json");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify(snap, null, 2));
      return { url, artifact: out };
    }
    if (action === "extract") {
      const selector = positionals[1];
      if (!selector) throw new Error("extract requires <url> <selector>");
      if (opts.attr) {
        const value = await session.page.locator(selector).first().getAttribute(opts.attr);
        return { url, selector, attr: opts.attr, value };
      }
      const value = await session.page.locator(selector).first().textContent();
      return { url, selector, value: (value ?? "").trim() };
    }
    if (action === "eval") {
      const expr = positionals[1];
      if (!expr) throw new Error("eval requires <url> <js-expression>");
      const value = await session.page.evaluate(expr);
      return { url, value };
    }
    throw new Error(`unknown one-shot action: ${action}`);
  } finally {
    await closeSession({ ...session, sessionFile: opts.session });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const startedAt = performance.now();

  if (parsed.command === "help" || !parsed.command) {
    process.stdout.write(helpText() + "\n");
    return;
  }
  if (parsed.command === "version") {
    process.stdout.write(VERSION + "\n");
    return;
  }
  if (parsed.command === "session-path") {
    process.stdout.write(JSON.stringify(ok("session-path", { dir: resolve(ARTIFACT_DIR) }, startedAt)) + "\n");
    return;
  }

  try {
    let result;
    if (parsed.command === "script") {
      result = await cmdScript({ opts: parsed.opts });
    } else if (["screenshot", "snapshot", "extract", "eval"].includes(parsed.command)) {
      result = await cmdOneShot(parsed.command, parsed.positionals, parsed.opts);
    } else {
      throw new Error(
        `unknown command "${parsed.command}". Run \`node cli.mjs --help\` for usage.`,
      );
    }
    process.stdout.write(JSON.stringify(ok(parsed.command, result, startedAt)) + "\n");
  } catch (err) {
    const hint =
      /playwright is not installed/.test(err.message)
        ? "This CLI needs the playwright runtime. It is NOT installed in this environment."
        : undefined;
    process.stdout.write(JSON.stringify(fail(parsed.command, err.message, hint)) + "\n");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
