# 0.5.3 final validation — 2026-09-13

## Decision

**Automated validation passes for main `b5c5413c`; release sign-off remains blocked.**
The checkout and generated archive still declare **0.5.2**. This is validation
of the merged 0.5.3 work, not verification of a published 0.5.3 candidate.

The remaining product gate is #4907 (completion reaction on the actual final
delivery), which is still open and absent from main. A versioned 0.5.3
candidate and Git-tag installation evidence must follow its implementation
and acceptance, or an explicit release-scope decision. The browser
coordination experiment #5002 is not a new release gate.

## Exact subject and environment

- Source commit: `b5c5413c6bf65212de32e74396d534296a866deb`.
- Clean, separate worktree; fresh `npm ci --no-audit --no-fund`; original workspace modifications were not included.
- Local runtime: macOS arm64, Node **20.20.2**, npm **10.9.9**. Toolchains were installed into isolated temporary prefixes.
- #4995 and #4999 are on main; #4997/#4998 were merged into their parent stack and reached main through #4996. The main tree matches the previously reviewed stack `56d35de2`.
- The same commit also passed [main CI on Linux / Node 20](https://github.com/hs3180/disclaude/actions/runs/34753567516).

## Build, tests, and coverage

| Check | Result |
| --- | --- |
| Fresh dependency installation | PASS |
| `npm run type-check` (includes build) | PASS |
| `npm run lint` | PASS |
| `npm run test:coverage` | **225 test files passed; 4,708 tests passed; 1 skipped** |
| Statements / lines | **90.57% / 90.57%** |
| Branches | **87.52%** |
| Functions | **93.43%** |
| Global coverage thresholds | PASS; each threshold is 70% |

The skipped test is the opt-in checkout installation case in
`tests/git-release-install.test.ts`. Installation was exercised separately
below, rather than counting a skipped test as evidence. The full suite covers
registry precedence/trust, `.disclaude` discovery, exec/app-server behavior,
project root separation, scheduler behavior, and persistent-error termination.
Most provider tests use controlled fake subprocesses; this is not a live-model
or live-Feishu acceptance run.

## Installed archive matrix

The prebuilt distribution was generated from the exact source above and packed
as `disclaude-0.5.2.tgz` without changing version metadata.

| Node | npm | Isolated install, module imports, CLI help/version, start/stop/restart |
| --- | --- | --- |
| 20.20.2 | 10.9.9 | PASS |
| 20.20.2 | 11.6.0 | PASS |
| 22.23.2 | 10.9.9 | PASS |
| 22.23.2 | 11.6.0 | PASS |

Every run emitted `CLI_START_STOP_RESTART_OK 0.5.2` and
`PACKAGE_INSTALL_OK 0.5.2`. The test uses isolated configuration, filesystem
prefix/cache, dynamic loopback API ports, synthetic offline configuration,
and a sentinel file that must survive restart. It never restarts the user's
running service.

Provenance:

- Source fingerprint: `9df50a75d816d6411fd73259c643d096c99bd85f6db4e041867db356b58243b8`.
- Archive SHA-256: `44921cc51f264774d2761081426fee8d15419f0a850306461279e7b0038c5747`.
- Archive size: **735,812 bytes**.
- Local archive: `/tmp/disclaude-053-final-distribution/disclaude-0.5.2.tgz` (temporary artifact, not a published release).

## Installed scheduled-channel acceptance (#4984)

[The reproducible probe](scheduled-channel-check.mjs) loads the installed
Scheduler, HttpApiServer, and the CLI's `publishChannelApiEnvironment` helper.
The scheduler launches the installed public channel CLI as a real child
process. The sink is a local HTTP handler; the schedule manager and timer are
fixtures. No Feishu account, model, or external message is involved.

Passed on Node 20.20.2:

1. Authenticated dynamic-port server: unauthenticated POST is rejected with
   401, and the scheduled CLI sends the expected bearer header and one delivery.
2. A second server binds another dynamic port while the first remains alive.
   The next tick uses the new endpoint with authentication disabled; the old
   token is removed and the actual request has no Authorization header.
3. Both commands complete; each server receives exactly one expected delivery,
   and the synthetic token is absent from captured stdout/stderr.

Result markers: `SCHEDULED_INSTALLED_CHANNEL_OK` for authenticated and
unauthenticated modes, and `SCHEDULED_INSTALLED_CHANNEL_MATRIX_OK`.
This closes the local packaged-client/environment evidence gap. It does not
claim live-channel delivery or file-watcher-driven cron startup was exercised
by this particular probe; public CLI lifecycle is covered by the matrix above.

## Reproduction

From the pinned checkout with Node 20.20.2 / npm 10.9.9 selected:

```sh
HUSKY=0 npm ci --no-audit --no-fund
npm run type-check
npm run lint
npm run test:coverage
node scripts/build-git-release.mjs /absolute/empty/distribution
npm pack --json --ignore-scripts /absolute/empty/distribution
node scripts/test-package-install.mjs /absolute/archive.tgz 9df50a75d816d6411fd73259c643d096c99bd85f6db4e041867db356b58243b8
node scripts/test-git-node22.mjs /absolute/archive.tgz 9df50a75d816d6411fd73259c643d096c99bd85f6db4e041867db356b58243b8
npm install --global=false --prefix /absolute/isolated-prefix --omit=dev --no-audit --no-fund /absolute/archive.tgz
node docs/releases/0.5.3/scheduled-channel-check.mjs /absolute/isolated-prefix/node_modules/disclaude
```

The probe is supplied by this evidence PR and is outside the product source
fingerprint. Preserve the fingerprint argument when invoking the matrix script.
During setup, a missing fingerprint argument and an invalid synthetic chat ID
caused probe failures; correcting the invocations/fixtures resolved both, with
no product code changes and no suppressed assertions.

## Outstanding release gates

- #4907: implement final-output reaction targeting and verify private/group/thread,
  streaming, cancellation, failed delivery, no-output, and reaction-retry behavior.
- Prepare actual 0.5.3 metadata and an immutable candidate after remaining P0 work;
  rerun affected acceptance and validate that exact artifact.
- Perform the existing supported Node/npm matrix against the final candidate
  and verify installation from its exact Git tag/SHA. The local archive matrix
  above is not evidence for a nonexistent v0.5.3 tag.

No tag, release, or deployment was performed in this validation.
