---
name: browser-use
description: "Browser tasks, scraping, screenshots and forms via browser-use. Pipe Python through the coordinator's IPC entry; it owns the persistent session and control handoff. Do not connect directly to CDP. Supports js() and cdp()."
argument-hint: "<piped Python via stdin, e.g. sh /absolute/path/to/this-skill/scripts/run.sh <<'PY' ... PY>"
allowed-tools: [Bash, Read, Write]
---

# Skill: browser-use (browser automation via Python-in-browser CLI)

Drive a real browser by piping **Python** to the `browser-use` CLI. The configured coordinator owns the browser
lifecycle and control handoff, keeps browser state across invocations, and reuses
the upstream harness for execution. Your code only describes **what to do in the page**.

> Replaces the Playwright MCP skill pattern (`mcp__playwright__*`) per the reduce-MCP direction.
> Tracked in [#4460](https://github.com/hs3180/disclaude/issues/4460).

## Coordinated IPC mode

Use [the launcher helper](scripts/run.sh) for the examples below, replacing
`/absolute/path/to/this-skill` with the directory containing this SKILL.md.
Resolve that directory from the exact manifest link you read; do not assume a
copy under `~/.agents/skills` or search the home directory for another copy.
It preserves Python stdin and, when `DISCLAUDE_BROWSER_SOCKET` is set, invokes
`$DISCLAUDE_BROWSER_BIN/browser-use` by absolute path. The service sets that
variable after coordinator readiness. Shell/tool PATH changes cannot select an
upstream same-named CLI through this helper. Without the service-managed
coordinator, the helper fails closed; it never falls back to a standalone
browser-use daemon.

A missing/non-executable managed launcher is a configuration failure. Report it;
do not search release directories, install another CLI or guess an alternate
socket. `BH_RUNTIME_DIR=/dev/null` and `BH_TMP_DIR=/dev/null` deliberately block
accidental upstream daemon access: do not override or unset them to retry.
A failure of this channel does not establish that all browser or desktop tools
are unavailable. Computer Use remains available for an appropriate authorized
alternative, without concurrently controlling the shared browser.

Keep using Python scripts on stdin. One invocation is one
operation segment: put dependent navigation, input and verification in the same
script. The service queues control requests and owns daemon startup/recovery;
do not call `--reload`, `--update` or start a separate browser daemon. Relative
artifact paths use the calling task directory. Shared pages and login state may
be visible to the next holder; this is expected. If the service is unavailable,
report that condition instead of bypassing the coordinator with a direct CDP
connection. Keychain access is not required for normal browser operation.

## Quick start

```bash
sh /absolute/path/to/this-skill/scripts/run.sh <<'PY'
new_tab("https://news.ycombinator.com")
print(page_info())
PY
```

- stdout is **whatever your Python prints** — `print()` is the result channel. Parse it directly.
- Each invocation requests control of the **shared browser**. Tabs can survive handoff,
  but another caller may have changed the page; inspect it before continuing.
- Empty stdin is an error — always pipe code.
- Read current link text and destinations before choosing a navigation selector;
  familiar sites can change their wording. Verify the destination after navigation.

## Helper reference (CLI 3.0, browser-use 0.13.7)

| Intent | Helper |
|---|---|
| open / navigate | `new_tab(url)` (first nav), `goto_url(url)` (re-nav in an open tab) |
| ensure a real tab is active | `ensure_real_tab()` (recommended first call if a tab/session may already be open) |
| page state (a11y snapshot equivalent) | `print(page_info())` |
| screenshot | `capture_screenshot()` → path |
| click at coordinates | `click_at_xy(x, y)` |
| type / fill | `type_text(text)`, `fill_input(selector, text)` |
| keys / scroll | `press_key(key)`, `scroll(x, y)` |
| **inject & run JS (eval)** | `js(code)` |
| **raw CDP call** | `cdp(method, ...)` |
| waits | `wait_for_load()`, `wait_for_element(selector)` |
| tab management | `list_tabs()`, `switch_tab(target)`, `close_tab(target)` |

Legacy pre-3.0 subcommands (`open`/`state`/`screenshot`/`eval`/`-c`/`--session`/`--cdp-url` …)
are **removed**; the CLI prints a migration hint if used. Use the configured IPC entry point.

> ⚠️ **First navigation in a session is `new_tab(url)`, not `goto_url(url)`** (upstream SKILL.md is
> emphatic about this). `goto_url` navigates an *already-open* tab; calling it before any tab exists
> is a common first-call mistake.

## Patterns

### Script injection / eval (first-class)

```bash
sh /absolute/path/to/this-skill/scripts/run.sh <<'PY'
new_tab("https://example.com")
print(js("document.title"))
print(js("JSON.stringify({links: document.querySelectorAll('a').length})"))
PY
```

Anything the page can do in JS, `js()` can do. For protocol-level control use `cdp(method, ...)`
(e.g. `cdp("Network.getCookies")`).

### Extract → structured output

```bash
sh /absolute/path/to/this-skill/scripts/run.sh <<'PY'
import json
new_tab("https://example.com")
print(json.dumps({"title": js("document.title"), "url": js("location.href")}))
PY
```

Prefer printing **one JSON blob** per invocation — it is the easiest contract for the caller.

### Screenshot artifacts

Save screenshots to the task workspace (never `/tmp` scratch that gets lost):

```bash
sh /absolute/path/to/this-skill/scripts/run.sh <<'PY'
import pathlib
dst = "workspace/shot-home.png"
pathlib.Path(dst).parent.mkdir(parents=True, exist_ok=True)
out = capture_screenshot(path=dst)   # writes the PNG to dst, returns the path
print(f"saved {out}")
PY
```

Then report the artifact path in your reply (or send it to the chat via the channel skill).

> ⚠️ **The `mkdir` line above is a hard prerequisite, not optional tidiness.** `capture_screenshot`
> does **not** create the parent directory. If `path=` points into a directory that doesn't exist,
> the call does **not** fail with `FileNotFoundError` — it **hangs until the IPC timeout** and the
> resulting `TimeoutError` stack trace points at `browser_harness/_ipc.py`, with nothing indicating
> the real cause (observed on browser-use 0.13.8 / browser-harness 0.1.9, attach mode; #4600).
> Always `mkdir(parents=True, exist_ok=True)` before writing to any non-existing path. The same
> applies to any other helper that writes to a caller-supplied path.

> ℹ️ `capture_screenshot(path=None, full=False, max_dim=None)` is defined in the `browser-harness`
> dependency (`helpers.py`). It writes the PNG to `path` (default a temp file) and **returns the
> path string** — verified from source. Pass `path=` to write straight to your workspace; do **not**
> treat the return as bytes.

## Environment

In disclaude coordinated mode, the operator configures the IPC socket and the
browser-use adapter on the task PATH. Use stdin scripts only. Browser startup,
connection settings and recovery belong to the coordinator. If the socket is
unavailable, report the error; do not start a daemon or connect directly.
Chromium Keychain access is not required for normal browser operations.
