# 0.5.0 release-candidate record

Status: candidate evidence is incomplete; do not publish or report `RELEASE_READY`.

## 2026-09-09 implementation audit correction

Main at `9476628115622b3f337919d2be7800ab1525db66` includes version preparation, not completion of every release goal. The earlier blanket S01–S08 implementation claim below is superseded: the DeepSeek provider still throws from `queryStream`/tool creation, named-preset resolution is not wired to runtime selection, script scheduling is absent, and scheduled context still defaults to reuse. See [SPECS current worker handoffs](SPECS.md) for per-package next actions. These are code gaps as well as external acceptance gaps.

PR #4848 already sets the root version to 0.5.0 and records GitHub-only distribution with a manual npm workflow; the root remains private. Do not repeat the version bump or turn npm publication into an acceptance test. The old checks below are historical evidence for their stated SHA, not certification of the current main. PR #4849's matrix contract checks declarations, not all runtime behaviors.

## Candidate

- Candidate SHA: `2827965ed6b92b0205a93345470d35214c240adc` (`origin/main`, 2026-09-09)
- Scope: partial S01–S08 implementations and regressions; remaining code and S09 acceptance are still required.
- Detailed round evidence: `.local/release-0.5.0/evidence/round-0064.md` in the release-loop worktree.

## Checks on the candidate

| Check | Result |
|---|---|
| `npm run lint` | pass |
| `npm run type-check` | pass (`tsc -b` and root `tsc --noEmit`) |
| `npm run build:core` | pass |
| `npm test` | pass (full Vitest run) |
| `git diff --check` | pass |
| `npm pack --dry-run --json` | pass; package remains `disclaude@0.4.0` |

## Acceptance matrix

S01–S08 have some merged implementation PRs and focused regression evidence. Mark individual acceptance items as missing, partial, or wired before verification; entire packages must not be marked `verifying` while their production call paths remain unimplemented. S09 is incomplete.

| Area | Current evidence | Remaining acceptance |
|---|---|---|
| Configuration, control, scheduling, concurrency and delivery | Focused tests and merged PRs | Re-run affected runtime scenarios on this candidate; retain backend/tool/final-delivery evidence |
| dsh backend | Contract and adapter tests | A real `dsh --profile sdk` run, including tool output and delivery receipt; this host reports that the profile is absent |
| Docker deployment | Static configuration checks | Isolated install, upgrade and rollback rehearsal; Docker is unavailable on this host |
| macOS launchd | `com.disclaude.primary`, `com.disclaude.chromium-cdp`, and `com.disclaude.log-cleanup` are loaded | Isolated install, upgrade and rollback rehearsal with backed-up state |
| Distribution | Historical pack dry-run; #4848 records GitHub-only distribution and manual npm workflow | Validate the intended GitHub artifact/install path on the new candidate; private root is not an npm publishing target |

## Release decision

The candidate is not release-ready. Do not change the version, create a tag or GitHub Release, publish an npm package, deploy, or close S09 until the remaining acceptance items above have evidence and the distribution policy is decided.

## Next evidence to collect

1. Complete the missing runtime call paths listed in SPECS, with targeted regression evidence; then run the real dsh SDK profile through conversation, tool, exception and final-delivery scenarios.
2. Perform isolated Docker and launchd install/upgrade/rollback rehearsals without touching the existing service state.
3. Audit matrix claims against actual executable test cases, repeat packaging validation for the intended distribution, and replace the old candidate SHA/checks with new evidence.
