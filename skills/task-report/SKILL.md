---
name: task-report
description: Report finished task artifacts or an independent review verdict to the owning host through `disclaude board-report write`. Use when a parent task pinned a report inbox for your work or review; the JSON payload goes on stdin.
---

# Task work and review proposals

Agents deliver structured work proposals through the disclaude CLI, not
injected tools or free-text claims. The owning host — never the reporting
agent — pins identities, verifies native settlement and persists the record,
so a receipt is a proposal, not approval or completion.

When your instructions name a report inbox (an absolute directory path) and a
kind, write exactly one proposal before finishing:

```bash
disclaude board-report write --inbox <absolute-inbox-path> --kind artifacts <<'JSON'
{"summary": "What was actually produced and checked", "refs": ["report.md"]}
JSON
```

- `kind artifacts` — after finishing worker tasks: `summary` (nonempty,
  ≤16000 chars) and `refs` (1–100 unique Project-relative file paths you
  actually produced and read back, ≤2048 chars each). Report the files you
  verified, not files you merely plan.
- `kind review` — after independently reviewing a fixed submission:
  `verdict` (`approved` | `changes-requested`), `reason` (nonempty,
  ≤16000 chars) and `evidence` — one entry per acceptance criterion you
  checked: `{"criterion": <zero-based index>, "note": "what you actually
  observed"}`. `approved` must cover every criterion; review only reads
  files, never modifies them.
- Identical redelivery is idempotent (safe after an uncertain retry). A
  different payload for the same inbox is refused — a poisoned operation
  needs a new operation from the owning host, not a rewritten receipt.
- Only the exact inbox path given to you is writable; a missing or foreign
  path is an error to report, not something to work around by writing files
  elsewhere. Never claim in chat output that a report was accepted — the
  `{"ok":true,"receipt":…}` stdout line is the only acknowledgement.
