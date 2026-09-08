# 0.5.0 release-candidate record

Status: candidate evidence is incomplete; do not publish or report `RELEASE_READY`.

## Candidate

- Candidate SHA: `2827965ed6b92b0205a93345470d35214c240adc` (`origin/main`, 2026-09-09)
- Scope: S01–S08 merged implementation, with S09 acceptance and release preparation still in progress.
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

S01–S08 have merged implementation PRs and focused regression evidence, but remain `verifying` until the missing runtime and deployment scenarios are demonstrated. S09 is `pending`.

| Area | Current evidence | Remaining acceptance |
|---|---|---|
| Configuration, control, scheduling, concurrency and delivery | Focused tests and merged PRs | Re-run affected runtime scenarios on this candidate; retain backend/tool/final-delivery evidence |
| dsh backend | Contract and adapter tests | A real `dsh --profile sdk` run, including tool output and delivery receipt; this host reports that the profile is absent |
| Docker deployment | Static configuration checks | Isolated install, upgrade and rollback rehearsal; Docker is unavailable on this host |
| macOS launchd | `com.disclaude.primary`, `com.disclaude.chromium-cdp`, and `com.disclaude.log-cleanup` are loaded | Isolated install, upgrade and rollback rehearsal with backed-up state |
| Distribution | `npm pack --dry-run --json` passes | Confirm whether the root private package is intentionally non-distributed or should be publishable; reconcile with `.github/workflows/publish.yml`, which invokes `npm publish` |

## Release decision

The candidate is not release-ready. Do not change the version, create a tag or GitHub Release, publish an npm package, deploy, or close S09 until the remaining acceptance items above have evidence and the distribution policy is decided.

## Next evidence to collect

1. Run the real dsh SDK profile through conversation, tool, exception and final-delivery scenarios, recording the version and sanitized event samples.
2. Perform isolated Docker and launchd install/upgrade/rollback rehearsals without touching the existing service state.
3. Resolve the `private: true` versus npm publish workflow decision, then repeat the packaging dry-run and update this record.
