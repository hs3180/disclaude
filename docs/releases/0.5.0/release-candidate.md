# 0.5.0 release-candidate record

Status: candidate evidence is incomplete; do not publish or report `RELEASE_READY`.

## Current audit baseline (2026-09-09)

Main: `987e4b91d5fbe804729eba12e72785a3aa7758ca`. No new release candidate has been selected. Public Releases contained only v0.3.1 at audit time; the prepared package version and dated Changelog did not indicate an actual 0.5.0 publication.

- [CI for this main SHA](https://github.com/hs3180/disclaude/actions/runs/34303609467) passed. Local build/type-check and lint passed; 313 focused tests in 10 files passed (preset validation/resolution, DeepSeek adapters, scheduler/watcher, streaming finalization and ChatAgent). These tests do not certify missing runtime paths or real backend delivery.
- [Script schedule PR #4851](https://github.com/hs3180/disclaude/pull/4851) is open with passing checks; its implementation is not in this baseline.
- [Matrix PR #4849](https://github.com/hs3180/disclaude/pull/4849) is closed without merging. No acceptance matrix from that PR is present in this baseline.
- Current workers found local dsh `0.1.2-rc.1` and SDK profile sources (`sdk-app 0.1.2-alpha.2`, `sdk-jsonrpc-server 0.1.2-rc.1`). This supersedes the old environment observation that the profile was absent, but does not establish a successful real model/tool/channel run.
- Runtime work and evidence gates are being submitted as independent PRs. Open PRs remain implementation/review work, not merged candidate evidence.

The tables below preserve historical observations for their stated candidate SHA and environment; do not copy their pass statuses to a newer candidate.

## 2026-09-09 implementation audit correction

Main at `9476628115622b3f337919d2be7800ab1525db66` includes version preparation, not completion of every release goal. The earlier blanket S01–S08 implementation claim below is superseded: the DeepSeek provider still throws from `queryStream`/tool creation, named-preset resolution is not wired to runtime selection, script scheduling is absent, and scheduled context still defaults to reuse. See [SPECS current worker handoffs](SPECS.md) for per-package next actions. These are code gaps as well as external acceptance gaps.

PR #4848 already sets the root version to 0.5.0 and records GitHub-only distribution with a manual npm workflow; the root remains private. Do not repeat the version bump or turn npm publication into an acceptance test. The old checks below are historical evidence for their stated SHA, not certification of the current main. PR #4849's matrix contract checks declarations, not all runtime behaviors.

## Historical candidate

- Candidate SHA: `2827965ed6b92b0205a93345470d35214c240adc` (`origin/main`, 2026-09-09)
- Scope: partial S01–S08 implementations and regressions; remaining code and S09 acceptance are still required.
- Detailed round evidence: `.local/release-0.5.0/evidence/round-0064.md` in the release-loop worktree.

## Historical checks on that candidate

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
| dsh backend | Contract and adapter tests; historical host reported the profile absent (superseded above) | A real `dsh --profile sdk` run, including executed tool output and final delivery receipt |
| Docker deployment | Static configuration checks | Isolated install, upgrade and rollback rehearsal; Docker is unavailable on this host |
| macOS launchd | `com.disclaude.primary`, `com.disclaude.chromium-cdp`, and `com.disclaude.log-cleanup` are loaded | Isolated install, upgrade and rollback rehearsal with backed-up state |
| Distribution | Historical pack dry-run; #4848 records GitHub-only distribution and manual npm workflow | Validate the intended GitHub artifact/install path on the new candidate; private root is not an npm publishing target |

## Release decision

The candidate is not release-ready. GitHub distribution and a private root are already the stated policy; artifact/install validation remains incomplete. Complete the remaining implementation and acceptance items before selecting a new release candidate. This evidence record does not authorize a tag, GitHub Release, npm publication, deployment or closure of S09.

## Next evidence to collect

1. Complete the missing runtime call paths listed in SPECS, with targeted regression evidence; then run the real dsh SDK profile through conversation, tool, exception and final-delivery scenarios.
2. Perform isolated Docker and launchd install/upgrade/rollback rehearsals without touching the existing service state.
3. Audit matrix claims against actual executable test cases, repeat packaging validation for the intended distribution, and replace the old candidate SHA/checks with new evidence.
