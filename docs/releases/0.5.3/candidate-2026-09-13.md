# 0.5.3 candidate — 2026-09-13

## Decision

The integrated **0.5.3** candidate passes automated source and installed-package
validation. PR #5003 implements the remaining completion-delivery product
change; candidate metadata and these evidence files are submitted separately.
Review and merge remain. No final `v0.5.3` tag or GitHub release has been created.

## Exact candidate

- Source: `32a8a6f31df8c99bf6034dfa5f0573fd88be85bb` (main `b5c5413c`, completion implementation `64edefd7`, release docs, and 0.5.3 metadata).
- Prebuilt Git commit: `0246f113f1e2ebdd866d4eec06139875c45b4eda`, branch `candidate/0.5.3-20260913`.
- Source fingerprint: `86d6668376337fbdc5972b31fc121add13e1365e229eb52befb61e22377e9a22`.
- Archive: `disclaude-0.5.3.tgz`.
- Archive SHA-256: `e91c3a1a052e23a25b0763a4fe76281e0ec024570cffdbd915d3cb6721b4ce05`.

Documentation-only follow-ups do not change this candidate's product sources;
`release-source.json` in the installed package identifies the exact source above.
The original user worktree's uncommitted files were not included.

## Source validation

On macOS arm64 with isolated Node **20.20.2** / npm **10.9.9**:

| Check | Result |
| --- | --- |
| Build and type-check | PASS |
| Lint | PASS |
| Full coverage suite | **226 files; 4,732 tests passed; 1 skipped** |
| Statements / lines | **90.56% / 90.56%** |
| Branches | **84.68%** |
| Functions | **93.50%** |
| Global coverage thresholds | PASS |

The skipped test is the opt-in checkout-install test. Real installation is
verified separately below. Tests cover shared SkillsRegistry/Codex parity,
trust/root separation, persistent runtime errors, scheduled command context,
and completion feedback.

## Installation matrix

| Input | Node | npm | Imports, help/version, start/stop/restart |
| --- | --- | --- | --- |
| Candidate archive | 20.20.2 | 10.9.9 | PASS |
| Candidate archive | 20.20.2 | 11.6.0 | PASS |
| Candidate archive | 22.23.2 | 10.9.9 | PASS |
| Candidate archive | 22.23.2 | 11.6.0 | PASS |
| Fixed Git commit above | 20.20.2 | 10.9.9 | PASS |

Each run reports `CLI_START_STOP_RESTART_OK 0.5.3` and
`PACKAGE_INSTALL_OK 0.5.3`, verifies the source fingerprint, and uses isolated
prefix/cache/configuration plus dynamic loopback ports. The running user
service was not restarted or replaced.

The Git input tested was:

```text
github:hs3180/disclaude#0246f113f1e2ebdd866d4eec06139875c45b4eda
```

This is a pinned candidate commit, not evidence for a nonexistent final tag.

## Installed-code completion acceptance (#4907)

[The completion probe](completion-delivery-check.mjs) loads the installed
ChatAgent, callback factory, and FeishuChannel. Only the SDK query and Feishu
API boundaries are replaced with local deterministic sinks; no live model,
WebSocket session, account credential, or external message is used.

Seven scenarios pass: P2P, ordinary group, topic, streaming success, streaming
freeze failure with text fallback, failed turn, and cancellation during
stream finalization. Assertions verify the actual outbound message receipt,
thread parent, completion emoji, finalization-before-reaction-before-onDone
ordering, suppression of standalone Complete text, and stream state cleanup.
Unit regressions additionally cover queued turns, delayed finalization,
missing/status receipts, send failure, bounded retry, and unknown-outcome timeout.

Result: `INSTALLED_COMPLETION_MATRIX_OK`.

Completion feedback is deliberately conservative: a channel without a real
receipt has no completion reaction. Tool-only output delivered outside these
callbacks is not guessed from the source request or a status message. Failed
reaction calls get one retry; timeout gets no retry because its remote outcome
is unknown. No extra text fallback is emitted for a reaction failure.

## Installed scheduled command acceptance (#4984)

[The scheduler probe](scheduled-channel-check.mjs) passes against this installed
0.5.3 package with authenticated and unauthenticated dynamic-port servers.
A real scheduled child process invokes the installed channel CLI, reaches the
current endpoint, uses/removes the synthetic token as appropriate, and sends
exactly one expected payload per mode.

Result: `SCHEDULED_INSTALLED_CHANNEL_MATRIX_OK`.

## Reproduction and remaining release work

```sh
npm run type-check
npm run lint
npm run test:coverage
node scripts/test-package-install.mjs <candidate-archive-or-git-ref> 86d6668376337fbdc5972b31fc121add13e1365e229eb52befb61e22377e9a22
node scripts/test-git-node22.mjs <candidate-archive> 86d6668376337fbdc5972b31fc121add13e1365e229eb52befb61e22377e9a22
node docs/releases/0.5.3/completion-delivery-check.mjs <installed-package-directory>
node docs/releases/0.5.3/scheduled-channel-check.mjs <installed-package-directory>
```

1. Review and merge #5003 plus the release metadata/evidence; retain CI results.
2. If review changes product sources, rebuild the candidate and repeat affected validation.
3. Final-tag installation verification and release publication follow the accepted source. Live Feishu/model acceptance is not claimed by these local probes.

Browser coordination experiment #5002 remains a separate lab proposal, outside
this patch release's gates.
