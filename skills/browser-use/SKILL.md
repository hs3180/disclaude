---
name: browser-use
description: Browser automation via the browser-use CLI — pipe Python on stdin, it runs in a persistent browser session with daemon/CDP attach managed for you. First-class script injection/eval (js(), cdp()). Use for browser tasks, scraping, screenshots, form filling, and executing arbitrary JS in a live page. Keywords: 'browser', '浏览器', '网页自动化', 'browser-use', 'screenshot', '网页截图', 'inject script', '注入脚本', 'eval js', 'scrape'.
argument-hint: "<piped Python via stdin, e.g. browser-use <<'PY' ... PY>"
allowed-tools: [Bash, Read, Write]
---

# Skill: browser-use (browser automation via Python-in-browser CLI)

Drive a real browser by piping **Python** to the `browser-use` CLI. The CLI owns the browser
lifecycle: it starts/attaches a daemon-managed Chrome, keeps the session persistent across
invocations, and handles waiting/tabs for you. Your code only describes **what to do in the page**.

> Replaces the Playwright MCP skill pattern (`mcp__playwright__*`) per the reduce-MCP direction.
> Tracked in [#4460](https://github.com/hs3180/disclaude/issues/4460).

## Quick start

```bash
browser-use <<'PY'
new_tab("https://news.ycombinator.com")
print(page_info())
PY
```

- stdout is **whatever your Python prints** — `print()` is the result channel. Parse it directly.
- Each invocation joins the **same persistent session** (default local daemon); state (tabs,
  cookies, logins) survives across calls.
- Empty stdin is an error — always pipe code.

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
are **removed**; the CLI prints a migration hint if used. `--cdp-url` became the `BU_CDP_URL` env var.

> ⚠️ **First navigation in a session is `new_tab(url)`, not `goto_url(url)`** (upstream SKILL.md is
> emphatic about this). `goto_url` navigates an *already-open* tab; calling it before any tab exists
> is a common first-call mistake.

## Patterns

### Script injection / eval (first-class)

```bash
browser-use <<'PY'
new_tab("https://example.com")
print(js("document.title"))
print(js("JSON.stringify({links: document.querySelectorAll('a').length})"))
PY
```

Anything the page can do in JS, `js()` can do. For protocol-level control use `cdp(method, ...)`
(e.g. `cdp("Network.getCookies")`).

### Extract → structured output

```bash
browser-use <<'PY'
import json
new_tab("https://example.com")
print(json.dumps({"title": js("document.title"), "url": js("location.href")}))
PY
```

Prefer printing **one JSON blob** per invocation — it is the easiest contract for the caller.

### Screenshot artifacts

Save screenshots to the task workspace (never `/tmp` scratch that gets lost):

```bash
browser-use <<'PY'
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

- Requires Python 3.11+ and the `browser-use` package; Chromium install: `browser-use install`.
- **First-run config dir**: `browser-harness` needs a writable home dir (default
  `~/.config/browser-harness`). On a clean host whose parent doesn't exist — or where `~/.config`
  isn't writable — even `browser-use --help` crashes (`ensure_private_dir` does `mkdir(parents=False)`).
  Set `BH_HOME=<writable-dir>` (or `XDG_CONFIG_HOME`) to redirect it; on headless/CI hosts the
  `BU_CDP_URL` path avoids this entirely.
- **Headless hosts**: pulling Chromium directly is fragile (shared libs / sandbox). Prefer a
  stable external CDP endpoint — set `BU_CDP_URL=<ws://host:port>` and the CLI attaches to it
  instead of launching its own browser (Chromium container decision: #4496).
- **Codex agent**: disclaude applies Codex's network allowance to the active sandbox profile,
  including `read-only` (`sandbox_read_only.network_access`). This keeps the default permission
  mode read-only while allowing the browser-use CDP connection; `agent.codexNetworkAccess: false`
  intentionally disables it.
- Health check: `browser-use doctor` (or `--doctor`); daemon restart: `browser-use --reload`.
- Upstream ships its own agent skill (`browser-use skill show`) — this repo's copy adds disclaude
  artifact/workspace conventions on top of the same CLI.
