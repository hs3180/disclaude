# disclaude 0.5.3 release acceptance — 2026-09-13

## Subject

- Source main: `3153a6befffcc567ed81c1f0e5a0db3cef182973`.
- Distribution: `3bce4ca2cda4c733881a6545fc46e077f35a139c`.
- Final tag: `v0.5.3`, pointing to the prebuilt distribution (not the source checkout).
- Runtime fingerprint: `86d6668376337fbdc5972b31fc121add13e1365e229eb52befb61e22377e9a22`.
- Archive SHA-256: `5c1ddf94420ad515b4f6d2246bf8c3a2832c2e5949c0e01a06fc5801804625a8`.

PR #5003 was owner-approved and merged; #5004 merged the version metadata and
validation documentation. Final main has the same tree as the integrated PR
head. Relative to the tested candidate source `32a8a6f3`, only release docs and
local integration probe documentation changed; the runtime fingerprint is
identical. The final archive was rebuilt from merged main.

## Source checks

- Build/type-check and lint: PASS.
- Accepted candidate full suite: 226 files, **4,732 tests passed**, 1 opt-in install test skipped.
- Coverage on Node 20.20.2: statements/lines 90.56%, branches 84.68%, functions 93.50%; all thresholds passed.
- PR #5003 CI: all four jobs passed — https://github.com/hs3180/disclaude/actions/runs/34759994729.
- PR #5004 CI on `45b4a2ac`: all four jobs passed — https://github.com/hs3180/disclaude/actions/runs/34760293944. The subsequent main merge changed ancestry only, with an empty tree diff.
- Final main build: PASS.

## Final artifact checks

The following checks were repeated against the final archive, not inferred
from its version string or the earlier candidate archive:

| Input | Node | npm | Install, imports, help/version, CLI start/stop/restart |
| --- | --- | --- | --- |
| Final archive | 20.20.2 | 10.9.9 | PASS |
| Final archive | 20.20.2 | 11.6.0 | PASS |
| Final archive | 22.23.2 | 10.9.9 | PASS |
| Final archive | 22.23.2 | 11.6.0 | PASS |
| `github:hs3180/disclaude#v0.5.3` | 20.20.2 | 10.9.9 | PASS |

Every run validates the runtime fingerprint and reports
`CLI_START_STOP_RESTART_OK 0.5.3` and `PACKAGE_INSTALL_OK 0.5.3`.
Runs use isolated installation prefixes, configuration, caches and dynamic
loopback API ports; the user's running service and workspace were untouched.

Both installed-code probes were repeated against a separate installation of
the final archive:

- `completion-delivery-check.mjs`: seven P2P/group/topic, streaming/fallback,
  failed-turn and cancellation scenarios pass. Actual installed ChatAgent,
  callback factory and FeishuChannel execute; only SDK and API boundaries use
  local sinks. Receipt, parent, reaction ordering and stream cleanup assertions pass.
- `scheduled-channel-check.mjs`: authenticated and unauthenticated modes pass.
  The installed CLI executes as a scheduled subprocess, follows the current
  dynamic endpoint, and uses/removes the synthetic token appropriately.

Result markers: `INSTALLED_COMPLETION_MATRIX_OK` and
`SCHEDULED_INSTALLED_CHANNEL_MATRIX_OK`.

## Limits

These checks do not claim live model or live Feishu acceptance. Reaction
feedback requires a correlated actual delivery receipt; tool-only external
messages without one are not guessed. Claude/Pi/DSH registry migration and
browser/CDP coordination are separate work, not hidden 0.5.3 deliverables.

This release is distributed through its GitHub tag and archive. The npm
registry publishing workflow was not invoked.
