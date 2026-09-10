# 0.5.0 release-candidate record

Status: candidate evidence is incomplete; do not publish or report `RELEASE_READY`.

## Feishu delivery and release-scope update (2026-09-10)

Runtime candidate: `41887ce7`, branch `fix/050-final-validation`, PR #4884.
The user explicitly authorized creating a dedicated test group and end-to-end
messages, and decided Docker deployment rehearsal is **non-blocking for 0.5.0**.
S08-A4/S09-A4 now require launchd only; Docker remains unverified follow-up work.
This supersedes Docker/Feishu-credential blockers in earlier records below.

Existing project Feishu application credentials successfully obtained a bot token.
The lark-cli Keychain login was unavailable, so a per-command environment token
was used without changing Keychain settings. A private release-validation group
was created with the existing Disclaude test group's sole user as a member.
Credentials, group identifiers and full receipts remain in ignored local evidence.

Real integration exposed and fixed three gaps:

- Primary-node erroneously required Anthropic API credentials for DeepSeek.
- A globally selected DeepSeek backend still received Claude-specific presets and
  default tool denies because BaseAgent only inspected an explicit override.
- DeepSeek token deltas and reasoning were emitted as deliverable text messages.
  Text now arrives at message boundaries, reasoning is excluded, and a missing
  final message can flush accumulated text at turn end.

Validation with `deepseek-v4.1-flash-expires-on-0910`:

- Real Channel CLI text, supported Card 1.0 and file sends were independently
  read back from the dedicated Feishu group.
- The downloaded file's SHA-256 matched the uploaded original.
- A model executed a Channel CLI send command and its marker was read back.
- On `41887ce7`, channel push → Primary Node → DeepSeek → Feishu automatic final
  reply delivered exactly `FEISHU_FINAL_050_OK`; a second push recalling that
  reply delivered the same intact marker. Neither reply contained token-per-line
  fragmentation or reasoning text.
- All five standalone DeepSeek provider live checks passed again on `41887ce7`.
- Full Node 20 coverage: **215 files / 4,616 tests passed**, exit 0. Statements /
  branches / functions / lines: **90.44% / 87.49% / 93.19% / 90.44%**.
- Build/type check, lint and targeted regression tests passed.

Scope: this is **REST/CLI ingress → live model → real Feishu egress**, not an
incoming Feishu WebSocket/user-event test. The local fixture initializes the real
outbound Feishu client but disables its WebSocket subscription, so no shared bot
subscription or unrelated chat is consumed. The isolated server, workspace and
PID were separate from existing services; the test process was stopped afterward.

A Card 2.0 attempt was rejected locally by the existing CLI's 1.0 validator; the
supported 1.0 card was delivered and read back. No claim is made that send_card
supports 2.0. An initial model tool test also attempted an extra interactive card
to its synthetic REST chat and received 400; that failed attempt is preserved.
The final push test used the real Feishu chat and requested only a plain reply.

Evidence: `.local/release-0.5.0/feishu-e2e/` holds the original failures, receipt
JSON, file download, model results, isolated-server logs and coverage output.
`tests/e2e/0.5.0/.local/feishu/acceptance.json` marks S02-A4 verified with hashed
live artifacts on the runtime candidate and passes schema validation. Other
criteria retain their incomplete states; this does not mark the whole release
ready. Claude/pi live acceptance, remaining criterion consolidation and final
review remain outstanding. The draft PR tracks remote CI for subsequent commits.

## Earlier DeepSeek live acceptance update (2026-09-10)

Runtime candidate: `ee14e2b7a8a78c20c423ecb34aa729a95f019320`, on
`fix/050-final-validation`, in [PR #4884](https://github.com/hs3180/disclaude/pull/4884).
The user supplied a private local `.env` and explicitly selected
`deepseek-v4.1-flash-expires-on-0910`. Both API key and custom endpoint were
forwarded to dsh 0.1.2-rc.1 without placing them in committed files.

Real testing exposed a persisted-session collision when the same logical chat
started another query after cancellation. The SDK only exposes initialize,
session/prompt and shutdown, with no persisted-session load/resume method. Each
query now receives a unique native session ID. Logical-key reset still locates
its active transports; late close of an old query cannot release its replacement.
Multi-turn history remains in one live input stream. A new query after cancellation
is a fresh native session, not a restoration of the previous session's history.

| Check | Result |
|---|---|
| Live single-turn stream and terminal result | pass |
| Native tool execution, file artifact and read-back | pass |
| Two sequential prompts with random marker recall in one stream | pass |
| Cancellation at tool-call notification | pass |
| New query using the cancelled query's logical chat key | pass |
| DeepSeek transport/provider/event/pool tests | 4 files / 21 tests pass |
| Full Node 20 coverage run with the session fix | **214 files / 4,614 tests pass**, exit 0 |
| Statements / branches / functions / lines | **90.44% / 88.08% / 93.19% / 90.44%** |
| Build/type check, lint, diff check | pass |

The committed-code live rerun records `ee14e2b7` with `dirty: false`; all five
checks pass. Evidence lives in `.local/release-0.5.0/deepseek-0910/`:
`acceptance.json` preserves the original failure, `committed/deepseek-live.json`
records the passing rerun, and `coverage-node20.log` records the full suite.
The full suite began with the fix in the working tree before it was committed;
it is evidence for that runtime change, not a clean-checkout claim.

GitHub App authentication is now working. The earlier candidate `8a62db74`
[passed all remote CI jobs](https://github.com/hs3180/disclaude/actions/runs/34429426442).
The DeepSeek fix has been pushed to the same draft PR for fresh remote CI.
No merge or publication has occurred.

The DeepSeek credential blocker is resolved. S02-A4 is still incomplete until
real Feishu final delivery is verified; model success does not replace a channel
receipt. Remaining acceptance includes authorized Feishu text/card/file delivery,
Claude/pi live checks, Docker deployment rehearsal, final CI/review and the
complete evidence matrix. `RELEASE_READY` remains false. The earlier status below
is historical and is superseded by this update where applicable.

## Earlier local candidate (2026-09-10, continuation)

Candidate: `62b75df050508e237e4ca6fdf709eec07a2a65fa`, branch
`fix/050-final-validation`. This includes the earlier local fixes plus:

- `dc0d08a5`: real Codex testing reproduced stop → immediate follow-up failing
  because the previous native turn was still active. Interruption now waits for
  its matching terminal event, coalesces duplicate interrupts, suppresses late
  output, and fails closed on missing completion. A natural-completion race may
  return “no active turn” to the interrupt RPC; the terminal event remains the
  authority. Added deterministic cancellation/resume and timeout regressions.
- `c535c8fa`: repeatable isolated launchd install/upgrade/rollback runner, explicit
  version entry, separate PID lock and shell-free launchctl path arguments.
- `62b75df0`: repeatable live Codex runner; stricter per-suite skipped/empty
  verdicts and shared-server ownership; valid channel fixture IDs, isolated file
  paths and explicit delivery targets; unique async probe IDs and consistent
  drain deadlines. Tool names alone no longer count as execution evidence.

| Check | Observed result |
|---|---|
| `npm run type-check` / `npm run lint` / `git diff --check` | pass, exit 0 |
| Full Vitest coverage using Node 20.20.2 | **214 files / 4,612 tests passed**, exit 0 |
| Coverage statements / branches / functions / lines (Node 20) | **90.46% / 88.09% / 93.19% / 90.46%**, all above 70% |
| Earlier full Node 24.8.0 run at `c535c8fa` | 214 files / 4,606 passed; later changes affect test harnesses, not the native runtime fix |
| Live Codex 0.153.4, app-server, gpt-5.6-sol | **tool artifact + read-back, acknowledged steer affecting final reply, cancellation during shell execution, immediate same-thread continuation all pass** |
| Live REST/AI integration exploration | Basic reply, task execution, multi-turn memory, chat isolation, pool helper and all four multimodal requests pass; initial REST drain deadline and channel tool suite failed, so the full exploratory invocation exited 2 |
| Affected REST suite after harness fixes, 120-second deadline | **pass**, exit 0, including async receipt versus completion, custom chat and error responses; exit-listener growth 0 |
| Live launchd baseline → candidate → baseline | **pass**, fresh dynamic API address and health at every stage, workspace sentinel preserved; test label/plist removed after stop/uninstall |
| Real DeepSeek request | **blocked**: route `deepseek-official` reported no API key; not counted as a passing backend |

All runtime tests used dedicated temporary workspaces. Launchd compared baseline
checkout `2f921fe2` (runtime SHA-256 prefix `d69738f4c9b1`) with the candidate's
independent built checkout (`d9caf940374d`), then restored the baseline. The full
hashes and source commits are in the stage records; identical thin CLI bootstrap
hashes alone are not used to claim a version change. No default launchd service
was targeted.

Reproduction instructions: [live checks](LIVE-VALIDATION.md) and
[launchd rehearsal](LAUNCHD-REHEARSAL.md). Local evidence is under
`.local/release-0.5.0/continuation/`:

- `coverage-node20-final.log`, `type-check-final.log`, `lint-final.log`;
- `codex-final/codex-live.json` (candidate, model and per-turn events);
- `launchd-candidate/launchd-rehearsal.json` (version identities, health, cleanup);
- `integration.log`, `integration-result.json` (initial failures retained);
- `integration-rest-fixed.log`, `integration-rest-result.json` (passing retest);
- `deepseek.json` (real missing-credential failure).

The exploratory integration run was followed by test-harness fixes; it is not a
blanket all-green certification of the final candidate. The final full Node 20 run
covers those harness changes, and the affected REST suite was executed again.
The channel suite now explicitly requires an authorized test delivery target;
without one it skips delivery checks and exits nonzero. Feishu receipts remain
missing rather than being replaced by a successful HTTP or model acknowledgement.

Remaining blockers are **real DeepSeek credentials/acceptance, real Claude/pi
acceptance, authorized Feishu text/card/file delivery receipts, Docker deployment
rehearsal, and final remote CI/review plus complete 44-criterion evidence**.
GitHub CLI and the configured noninteractive credential helper supplied no usable
GitHub credential. Changes are local commits; no PR was created, no merge or
publication was performed. Docker/alternative container runtimes were unavailable.
The launchd installation/upgrade/rollback gap from the earlier record is now
closed for this macOS host; the Docker variant of S08/S09 remains blocked.

`RELEASE_READY` is still false. The evidence gate must continue rejecting the
incomplete manifest; passing local suites do not waive missing live variants.

## Earlier local candidate (2026-09-10, first pass)

Candidate: `4efda382a9a813daad5098eadfe69a6cdd67c862`, branch
`fix/050-final-validation`, based on fetched main `3efaad9bb641f0a9a506e4f4a974a208ec50070f`.
The earlier runtime-gap observations below are historical. Main now contains
runtime presets, direct command schedules, acknowledged Codex app-server steer,
ordinary scheduled Agent sessions, Channel API address propagation and hardened
evidence validation.

This candidate adds the remaining launchd isolation guard, explicit test config
and PID-lock separation; prevents integration tests from adopting/killing an
unrelated service; rejects skipped/empty integration acceptance; fixes a broken
provider-error shell regression and includes shell regressions in normal CI;
limits package contents to exclude local runtime/evidence logs; and corrects
installation/version documentation.

| Executed check | Result |
|---|---|
| `npm ci --include=dev` | pass, independent worktree dependencies |
| `npm run type-check` (includes build) | pass, exit 0 |
| `npm run lint` | pass, exit 0 |
| `npm run test:coverage` | pass, 213 files / 4,602 tests; exit 0 |
| Coverage statements / branches / functions / lines | 90.42% / 89.26% / 93.49% / 90.42%; all exceed 70% |
| `npm run test:rfc3329` | pass, 3 files / 21 tests |
| Bash helper regressions | pass in Vitest, including provider errors, quota, drain, build, pool, lifecycle and runner verdicts |
| Isolated REST listener start/health/stop | pass on an OS-selected test port; process and port released |
| `npm pack --dry-run --json` and `npm pack` | pass; no `.local`, workspace or coverage artifacts in pack inventory |
| Extracted tarball in an external cwd | help, channel help, send_text and push pass against a local HTTP fixture |
| Isolated launchd `generate` | plist parses; test label, explicit config and separate PID lock verified; no launchctl operation |
| `git diff --check` | pass |
| Evidence validator `--schema` | pass; schema validation only |
| Evidence validator `--gate --candidate <SHA>` | expected rejection, exit 1; missing candidate-specific acceptance evidence |

Environment: macOS arm64, Node 24.8.0, npm 11.6.0. This is local validation,
not the CI Node 20 environment. Raw logs and scripts are local at
`.local/release-0.5.0/final-audit/`; see `coverage-final.log`,
`type-check-final.log`, `lint-final.log`, `rfc3329.log`, `rest-isolation.log`,
`package-smoke.json`, `launchd-generation.json`, `packed.json`, and `gate.log`.
The packaged send/push fixture proves CLI routing only, not real tool execution
or Feishu delivery. Bundled SDK binaries make the local tarball platform-specific;
use the documented GitHub source checkout on other platforms.

Remaining release blockers:

1. Real Claude/Codex/pi/DeepSeek conversation, executed tools, failure/cancel and
   final delivery evidence tied to this candidate; real active-turn steer.
   The historical DeepSeek credential failure has not been re-certified as fixed.
2. Real Feishu card/plain-message receipts. No message to a real recipient was
   sent by this validation run.
3. Docker installation/upgrade/rollback (Docker unavailable here), and full
   isolated launchd install/start/upgrade/rollback/stop. Generation is not an
   installation rehearsal; no existing service was restarted.
4. Candidate remote CI and reviewed, complete 44-criterion evidence records.
   GitHub CLI has no authenticated session; no PR, tag, release or deployment
   was created. Public git refs were fetched, but do not substitute for CI.

Do not report `RELEASE_READY`. This record closes local validation fixes and
records a passing local regression baseline; it does not close S09.

## Historical audit baseline (2026-09-09)

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
