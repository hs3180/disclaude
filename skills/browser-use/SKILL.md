---
name: browser-use
description: "Browser tasks, scraping, screenshots and forms through the coordinated browser-use CLI. One invocation is one exclusive unit on the shared browser. Supports Python helpers, js() and cdp()."
argument-hint: "<piped Python via stdin, e.g. sh /absolute/path/to/this-skill/scripts/run.sh <<'PY' ... PY>"
allowed-tools: [Bash, Read, Write]
---

# Skill: browser-use (browser automation via Python-in-browser CLI)

Drive the deployed browser by piping **Python** to the upstream `browser-use` CLI.
Disclaude automatically serializes calls; the upstream CLI maintains its persistent
session. No acquire/release commands are needed.

## One invocation, one exclusive unit

Use [the launcher helper](scripts/run.sh), resolving its absolute path from the
SKILL.md you read. It preserves stdin and invokes Disclaude's wrapper even when a
shell changes PATH. The wrapper waits for the shared browser lock, runs the original
CLI, and releases control when that command exits. Users configure neither a
coordinator socket nor a launcher path.

Put dependent navigation, input and verification in **one script**. Between calls,
another task may change the page: inspect current state before continuing.
Tabs and login state persist; exclusivity does not roll back browser side effects.

A missing runtime/launcher is a service setup error; report it instead of bypassing
coordination with an absolute upstream CLI or direct CDP connection. The task's
`BH_RUNTIME_DIR=/dev/null` guard is replaced by the wrapper automatically; do not
unset it. Computer Use can be an authorized alternative, but must not concurrently
control this shared browser.

After a failed/interrupted invocation, the outcome may be unknown. Do not
automatically retry side effects. Inspect the error and result; when recovery is
appropriate, the same helper accepts `--reload` to stop the upstream session under
the same lock. Reload may close the daemon-owned tab. The next call creates a fresh
session; no Chromium/profile reset is required. Do not start a second daemon manually.
Relative artifact paths use the calling task directory.

## Quick start

```bash
sh /absolute/path/to/this-skill/scripts/run.sh <<'PY'
new_tab("https://news.ycombinator.com")
print(page_info())
PY
```

- stdout is **whatever your Python prints** — `print()` is the result channel. Parse it directly.
- Each invocation exclusively uses the **shared browser**. Tabs can survive handoff,
  but another caller may have changed the page; inspect it before continuing.
- Empty stdin is an error — always pipe code.
- Read current link text and destinations before choosing a navigation selector;
  familiar sites can change their wording. Verify the destination after navigation.

## Helper reference (CLI 3.0, validated with browser-use 0.13.10)

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
are **removed**; the CLI prints a migration hint if used. Use the coordinated launcher.

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

The service reads installed `chromium-cdp.json` first, with `BU_CDP_URL` as a
service-side fallback, and finds the original CLI on its PATH. It does not choose
Python, install a venv, launch Chromium, or require Keychain access.
