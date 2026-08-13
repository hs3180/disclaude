# browser-use Skill (CLI)

Browser automation as a **CLI Skill** — the pi-aligned "Skills = CLI + README" model — replacing
the **Playwright MCP server** (disclaude's largest MCP dependency) per the reduce-MCP direction.

- Tracked in [#4460](https://github.com/hs3180/disclaude/issues/4460) · Skill format per
  [#4459](https://github.com/hs3180/disclaude/issues/4459) · CDP/Chromium source decision:
  [#4496](https://github.com/hs3180/disclaude/issues/4496)
- Direction (owner, 2026-08-13): **browser-use CLI**, because script injection/execution is a
  first-class capability there ("write Python freely in the browser"), which verb-primitive CLIs
  (navigate/click/type/snapshot) cannot serve.

> **Status (part 1):** the Skill contract is defined — SKILL.md + this README document the command
> surface, the Playwright-MCP capability mapping, and the artifact/output contract. All claims
> about the CLI are evidenced from the upstream **browser-use 0.13.7 wheel** (`cli.py`,
> `entry_points.txt`); nothing here is speculative. **Deferred:** host-side CLI install + live
> round-trip acceptance (part 2, needs the runtime on the deployment host — see
> [Runtime](#runtime)), parity sign-off vs Playwright MCP (part 2), and removal of the Playwright
> MCP server (final part, only after parity is proven).

---

## Why browser-use CLI (and not a Playwright CLI wrapper)

The previous approach (closed PR #4464) wrapped Playwright in a verb-primitive CLI. The owner's
core need is **injecting/executing scripts in the page**, which maps to free-form Python + `js()` /
`cdp()` — exactly the browser-use CLI contract. The browser-use CLI is still a plain CLI (pipes
on stdin, prints on stdout), so it fits the "Skills replace MCP" philosophy without an MCP server.

## CLI surface (evidenced from browser-use 0.13.7 wheel)

Console scripts: `browser-use`, `browser`, `bu` (→ `browser_use.cli:main`);
`browser-use-tui` (deprecated shim).

| Invocation | Meaning |
|---|---|
| `browser-use <<'PY' ... PY` | **Core mode**: run piped Python in the persistent browser session |
| `browser-use install` | Install Chromium + system deps (delegates to `uvx playwright install chromium --with-deps --no-shell`) |
| `browser-use init` / `--template` | Project init |
| `browser-use skill show` / `skill install` | Show / install the upstream agent skill |
| `browser-use doctor [--fix-snap]` | Health check (install, daemon, browser) |
| `browser-use --reload` | Restart the local daemon |
| `browser-use --mcp` / `--cli-mcp` | MCP server modes (kept for external consumers; not the disclaude path) |

Legacy pre-3.0 subcommands (`open`, `state`, `screenshot`, `eval`, `-c`, `--session`, `--cdp-url`,
`--headed`, …) are removed and print a migration hint; notably `--cdp-url` is now the
`BU_CDP_URL` env var — that is the attach point for the #4496 Chromium container.

## Capability mapping: Playwright MCP → browser-use (issue Scope 2)

| Playwright MCP capability | browser-use helper | Notes |
|---|---|---|
| `navigate` | `new_tab(url)` / `goto_url(url)` | |
| `click` | `click_at_xy(x, y)` | coordinate-based; derive coords from `page_info()` |
| `type` | `type_text(text)` / `fill_input(selector, text)` | |
| `screenshot` | `capture_screenshot()` | returns bytes; write to workspace path |
| accessibility snapshot | `print(page_info())` | page state incl. clickable elements |
| extract content | `js(code)` + `print()` / `json.dumps` | |
| **script injection / eval** (new, first-class) | `js(code)`, `cdp(method, ...)` | owner's core requirement — the reason for the direction change |
| session/cookies | persistent daemon session; `cdp("Network.getCookies")` | named local sessions were removed (pre-3.0) |
| multi-tab | `list_tabs()`, `switch_tab(target)`, `close_tab(target)` | |
| waits | `wait_for_load()`, `wait_for_element(selector)` | daemon also auto-waits on load |

## Output & artifact contract

- **stdout is the result channel**: the CLI prints exactly what the piped Python prints. Skills
  should print **one JSON object** per invocation for machine parsing; screenshots and other
  binary artifacts are written to **workspace-relative paths** (reported in stdout), never to
  ephemeral `/tmp` scratch.
- **Session persistence**: consecutive invocations share one default local daemon session
  (cookies/logins/tabs survive). No session file plumbing (the pre-3.0 `--session` concept is
  gone).
- **Errors**: nonzero exit + stderr tail; unknown helpers raise `NameError` with an inline
  migration hint showing the correct helper.

## Runtime

- Python **3.11+** (`pip install browser-use`); Chromium via `browser-use install`
  (needs `uvx` on PATH).
- **Headless hosts** (disclaude deployments): launching Chromium in-place is fragile (missing
  shared libs, sandbox/seccomp friction). The supported path is an external, stable CDP endpoint
  via `BU_CDP_URL=<ws://host:port>` — browser-use, Playwright, and the existing CDP infra
  (#4151/#4164/#4099) can all attach to the same endpoint. Whether that endpoint is a dedicated
  Chromium container is decided in #4496; this skill does not depend on the outcome.
- Upstream skill reference:
  `browser-use skill show` (or the [upstream SKILL.md](https://github.com/browser-use/browser-use/blob/main/browser_use/skills/browser-use/SKILL.md)).

## Remaining parts (issue #4460)

1. ✅ **part 1 (this PR)**: Skill contract — SKILL.md + README + capability mapping (wheel-evidenced)
2. ⬜ **part 2**: host-side runtime bring-up (`browser-use install` or `BU_CDP_URL` per #4496) +
   live acceptance: screenshot/snapshot round-trip, eval round-trip, end-to-end browser task
3. ⬜ **final part**: remove the Playwright MCP server from disclaude; record parity deltas
   explicitly (no silent gaps); migrate `skills/playwright-agent` / `skills/site-miner` consumers
