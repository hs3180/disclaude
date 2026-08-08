# Playwright Skill (CLI)

Browser automation as a **CLI Skill** — the `@earendil-works`/pi-aligned "Skills = CLI + README"
model — replacing the Playwright **MCP server** (`@playwright/mcp`, `mcp__playwright__*` tools).

Tracked in [#4460](https://github.com/hs3180/disclaude/issues/4460). Part of the "reduce MCP"
direction ([#4459](https://github.com/hs3180/disclaude/issues/4459)): the Playwright MCP server is
disclaude's largest MCP dependency; this skill is its CLI-native replacement.

> **Status (part 1):** the CLI command surface + disk-artifact contract are implemented and verified
> at the import / launch / validation layer. **Live browser parity** (acceptance: "agent can
> end-to-end drive a browser") is deferred to **part 2** — it requires the Playwright runtime + OS
> libs on the host (see [Runtime](#runtime)). The `@playwright/mcp` dependency is **not yet removed**
> (that cutover is part 2, after parity is proven).

---

## Quick start

```bash
# 1. one-time runtime install (needs OS GTK libs — see Runtime)
npm install playwright && npx playwright install chromium

# 2. screenshot a page
node skills/playwright-agent/cli.mjs screenshot https://example.com --out shot.png

# 3. multi-step automation in one browser session
node skills/playwright-agent/cli.mjs script --steps '[
  {"action":"nav","url":"https://example.com"},
  {"action":"click","selector":"a"},
  {"action":"screenshot","out":"after.png"}
]'
```

Every command prints exactly **one JSON object** on stdout for the agent to parse:

```jsonc
// success
{"ok":true,"command":"screenshot","url":"https://example.com","artifact":"shot.png","durationMs":820}
// failure (exit code 1)
{"ok":false,"command":"screenshot","error":"...","hint":"..."}
```

---

## Commands

### One-shot (launch → act → close; self-contained)

| Command | Args | Options |
|---|---|---|
| `screenshot <url>` | url | `--out PATH` `--full` `--wait MS\|SEL` `--session FILE` |
| `snapshot <url>` | url | `--out PATH` `--wait MS\|SEL` `--session FILE` |
| `extract <url> <selector>` | url, selector | `--attr NAME` `--session FILE` |
| `eval <url> <expr>` | url, JS expression | `--session FILE` |

### Multi-step (one browser session, many steps)

`script --steps '<JSON>' | @FILE` — runs all steps in a **single** browser context and returns
per-step results. This is the workhorse for real automation (the MCP "live session" equivalent).

Step `action`s: `nav` `back` `forward` `click` `hover` `type` `fill` `select` `press` `wait`
`screenshot` `snapshot` `extract` `eval`.

```jsonc
[
  {"action":"nav","url":"https://example.com","wait":"h1"},
  {"action":"type","selector":"#q","text":"hello","submit":true},
  {"action":"extract","selector":".result"},
  {"action":"screenshot","out":"result.png","full":true}
]
```

### Utility

- `session-path` — print the resolved artifact directory (no browser needed).
- `--help` / `-h`, `--version` / `-v`.

---

## Disk-artifact contract (cross-invocation state)

A CLI is a fresh process per call, so a browser can't stay open between calls the way the MCP
server keeps one live. State is carried on disk instead:

| Artifact | Where | Purpose |
|---|---|---|
| Screenshots | `--out` or `<ARTIFACT_DIR>/step-<i>-screenshot.png` | `--full` for full-page |
| Accessibility snapshots | `--out` or `<ARTIFACT_DIR>/step-<i>-snapshot.json` | `page.accessibility.snapshot()` JSON |
| Session state | `--session FILE` (Playwright `storageState`) | cookies + localStorage, reused across runs |

Override the artifact dir with `PLAYWRIGHT_SKILL_DIR` (default `.playwright-skill`).

**MCP → CLI model difference (explicit):** the Playwright MCP returns **element refs** from
`browser_snapshot` that later `browser_click` calls reuse against the still-open page. This CLI is
**selector-based**: the agent reads the snapshot JSON, picks a CSS/Playwright selector, and passes it
to a subsequent `click`/`type` step. Within a `script` call the page stays open, so a `snapshot`
step followed by a `click` step works just like the MCP flow; across separate CLI calls, re-`nav`
inside a new `script`.

---

## Parity with `@playwright/mcp` (acceptance: parity differences recorded, not silent)

| Playwright MCP tool | CLI equivalent | Notes |
|---|---|---|
| `browser_navigate` | `nav` step / one-shot `<url>` | ✓ |
| `browser_navigate_back` / `_forward` | `back` / `forward` step | ✓ |
| `browser_click` | `click` step (`selector`) | selector-based, not ref-based |
| `browser_hover` | `hover` step | ✓ |
| `browser_type` | `type` step (`text`, `submit`) | ✓ |
| `browser_fill_form` | `fill` step (`fields[]`) | ✓ |
| `browser_select_option` | `select` step (`values[]`) | ✓ |
| `browser_press_key` | `press` step (`key`) | ✓ |
| `browser_wait_for` | `wait` step / `--wait` | MS or selector |
| `browser_take_screenshot` | `screenshot` / one-shot | `--full` |
| `browser_snapshot` | `snapshot` / one-shot | JSON artifact |
| `browser_evaluate` | `eval` step / one-shot | ✓ |

**Gaps (not yet covered — explicit, deferred):** `browser_drag`/`browser_drop`,
`browser_file_upload`, `browser_handle_dialog`, `browser_tabs` (multi-tab), `browser_resize`,
`browser_console_messages`/`browser_network_requests`, `browser_find`, `browser_element` screenshots.
For these today, fall back to an `eval` step (arbitrary JS via `page.evaluate`) or run the MCP tool
if still configured. Part 2 will close the high-value gaps (console/network capture, tabs).

---

## Runtime

This CLI shells out to the `playwright` Node library, which needs **both**:

1. The npm package: `npm install playwright`
2. A browser binary: `npx playwright install chromium`
3. **OS shared libraries** for Chromium (GTK/glib stack). On Debian/Ubuntu:
   `npx playwright install-deps chromium` (needs root), or `apt-get install -y libglib2.0-0
   libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libdbus-1-3 libxcb1
   libxkbcommon0 libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1
   libpango-1.0-0 libcairo2 libasound2`.

If `playwright` is missing, browser commands print a JSON error with the install hint instead of
crashing. `--help` / `--version` / `session-path` always work without the runtime.

> Dev-sandbox note: this CLI was verified through import + browser launch in a container that lacks
> the Chromium OS libs (`libglib-2.0.so.0`), so the live page round-trip could not be executed
> there. CI's `ubuntu-latest` has the libs; a standard dev host does after `install-deps`.

---

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `PLAYWRIGHT_SKILL_BROWSER` | `chromium` | `chromium` \| `firefox` \| `webkit` |
| `PLAYWRIGHT_SKILL_HEADLESS` | `1` | `0` to run headed |
| `PLAYWRIGHT_SKILL_DIR` | `.playwright-skill` | artifact directory |
