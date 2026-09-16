# 0.6.0 delivery readiness — 2026-09-17

**Not ready for release.** The milestone has nine open issues. Passing subsets
below do not close their remaining acceptance criteria. This report is a snapshot
of GitHub and local acceptance evidence checked at 02:45 CST; it is not a release
approval or a declaration that the current production installation is 0.6.0.

## Source and evidence boundaries

| Source | What has been verified | Limit |
| --- | --- | --- |
| Project harness PR [#5021](https://github.com/hs3180/disclaude/pull/5021), `1800dd1983a237c129a1388ce162cfa51d89a1bb` | Build/lint; 4,847 tests passed, eight skipped; real Codex waiting task reopens and consumes a new live Docx answer comment | Captured card transport; real project UI/callback journey remains open |
| Current local combined candidate `8f5c84f4b2cb94a52c33782b740bb7d37ed17971` | Includes the waiting-answer fix; build and 55 affected task/harness/CLI/process-recovery tests passed (one opt-in test skipped) | Broader prior-candidate evidence is historical; no new remote distribution or complete installation matrix |
| Previous local combined candidate `34d58c7213a4691b10b5054a519c0c9b914ed960` | Build/lint; 4,919 tests passed, 21 skipped; actual ordinary-agent task creation; four-provider shared-browser handoff; eight archive-install combinations; isolated upgrade/rollback | Predates runtime fix `1800dd19`; not a remote Git distribution; version label remains 0.5.3 |
| Input-request PR [#5023](https://github.com/hs3180/disclaude/pull/5023), `9bf20039` | Real public-card submission resumes the original Codex turn, including a wait exceeding four minutes; private protocol fixture through the real channel | Native Codex 0.154.0 model tool does not expose `isSecret`; fixture evidence is not native-model secret-question evidence |
| Cleanup PR [#5053](https://github.com/hs3180/disclaude/pull/5053), `e12bc80e` | Owned-process cleanup, native browser CI, Docker lifecycle and intentional failure cleanup | Does not establish adoption by every older E2E entry or every crash scenario |
| Article acceptance PR [#5052](https://github.com/hs3180/disclaude/pull/5052), `b48fa3a3` | Distinguishes browser lifecycle success from unsuccessful article retrieval | Requested WeChat article returned an environment/captcha barrier and zero body characters |

The current combined candidate's runtime fingerprint is
`f73e3e0c761b17a998cf78c235939a19f87c8ee1ce37765dc02917046808b685`.
The previous combined candidate's runtime fingerprint is
`8632ca6e4c5c6bdd0c4ff403e498cb8d4e7cfc0ee581c6dd82f2fc2cffb18212`.
It must not be attributed to the later harness runtime. Archive installation
covered macOS ARM64 and Linux ARM64 (non-root), Node 20.20.2/22.23.2 and
npm 10.9.9/11.6.0. Upgrade/rollback used a pinned 0.5.3 baseline distribution
`3bce4ca2cda4c733881a6545fc46e077f35a139c` and preserved synthetic config,
workspace and runtime-env bytes and mode 0600. This is neither remote SHA/tag
installation nor migration of real user data.

Four-provider browser evidence used DeepSeek, Codex, Claude and Pi. Codex received
a natural-language task and the browser skill; the other three received explicit
browser commands. Each verified shared prior state and independent readback.
This is not proof of natural-language research across all providers or platforms.

The 02:45 CST check of `1800dd19` found build, lint, unit tests, product-browser
and service lifecycle checks passing; coverage remained running in
[CI run 35135563498](https://github.com/hs3180/disclaude/actions/runs/35135563498).
A pending job is not a failure or a completed gate.

## Open milestone gates

| Issue | Evidence currently available | Still required before declaring that issue complete |
| --- | --- | --- |
| [#5014](https://github.com/hs3180/disclaude/issues/5014): coordinated browser access | Product IPC/managed-browser handoff, failures/recovery, model calls and environment tests | Trace the complete marked legacy-CDP injection case through actual main/subagent launch paths, prompts and skills; verify existing-configuration upgrade coverage on macOS and Docker/Linux. Preserve the stated same-user cooperation boundary; do not claim a hostile-agent sandbox. |
| [#5002](https://github.com/hs3180/disclaude/issues/5002): product browser service | Actual service startup, IPC control, release-archive contents and multiple model handoffs | Final candidate/platform coverage, including the issue's L1/L2/L3 experiments and two-real-agent draft scenario, must be mapped to concrete evidence. Sequential model handoffs alone do not prove simultaneous agent contention. Reconcile persistent queue/login recovery decisions explicitly. |
| [#5000](https://github.com/hs3180/disclaude/issues/5000): requestUserInput | Original-request response, real public cards, long wait, private channel fixture and deterministic lifecycle tests | Complete the per-criterion card/lifecycle audit against the final candidate, preserving the distinction between native model requests and private protocol fixtures. Keep approval/MCP behavior separate. |
| [#4990](https://github.com/hs3180/disclaude/issues/4990): static Card 2.0 | CLI validation, shape passthrough, authenticated real send and API readback | The issue's current progress record retains visual rendering as unobserved. Inspect the actual digest card and preserve legacy/invalid-input coverage on the selected candidate. |
| [#4924](https://github.com/hs3180/disclaude/issues/4924): unified service/container migration | Container lifecycle, non-root API/data, selected harness/scheduling cases, archive install and synthetic upgrade/rollback | Current old-role-removal inventory and all listed migration regressions; final-source remote SHA install on both platforms and Node/npm matrix; real channel/model scheduling and data-preserving deployment evidence. Archive passes cannot close the explicit remote-install gate. |
| [#4828](https://github.com/hs3180/disclaude/issues/4828): browser setup/deployment | Native macOS/Linux and Docker lifecycle/CDP evidence; downloaded-browser and systemd CI cases | Complete interactive/non-TTY setup, multiple/invalid browsers, repeated setup, profile-version/lock migration, missing-user-systemd diagnosis, legacy manual-deployment migration/rollback, and actual login/autostart/session persistence evidence. Copying a profile does not prove cookie decryption or login persistence. |
| [#4800](https://github.com/hs3180/disclaude/issues/4800): headed Chromium/target article | Headed/Xvfb/profile lifecycle works; site probe correctly reports failure | The specified article must yield a real body in the deployment environment. Record exact fingerprint observations, including language/WebGL residuals and requested detection-page evidence; do not infer cause or claim fingerprint elimination from launch flags. Current target result contradicts success. |
| [#4754](https://github.com/hs3180/disclaude/issues/4754): persistent task harness | Generic turns/checkpoints, natural task capability, non-research task, cancellation, process recovery, live body/comment recovery and waiting-task answer | Final-source real Feishu project lifecycle: start, intervene, stop/pause/resume/cancel, reenter, continue from results, parallel project isolation, and user-visible permission/notification/sync/cleanup failure behavior. API/model runs with captured cards are supporting evidence. |
| [#4753](https://github.com/hs3180/disclaude/issues/4753): project workspace UX | Default project task entry, durable evidence/feedback/control state, compatibility and source handling | Actual user interaction showing progress/blockers/actions without searching chat; repeated scope changes and counterevidence; source/feedback traceability, follow-up from findings, reentry and failure behavior jointly with #4754. Earlier research-command UI evidence does not cover the new entry. |

The harness/project acceptance retains the user-defined architecture: no separate
research command, mode or enablement step, and no mandatory
plan/investigate/synthesize sequence. Research uses the same persistent state and
control capabilities as other project work. Internal legacy names alone are not
a second product mode.

## Recent recovery evidence

[The recovery record](project-recovery-2026-09-17.md) describes both pre-checkpoint
and post-checkpoint owner-process crashes with real document/model APIs. The later
case preserves the completed A41/B48 baseline and consumes a changed body A58 plus
a B14 rebate comment, producing A58/B34/savings24 in the same task.

The separate `1800dd19` live answer check used a new synthetic document with quotes
for 2024 and 2025. Codex explicitly asked for a period and persisted `waiting-user`.
After that process exited, a real comment selected 2025. A fresh process reopened
the same waiting task and, without direct manager feedback injection, resumed to
A64/B39/savings25. The matching comment receipt was applied with work references;
the body was unchanged. Eight observed process groups, the private task directory
and XML draft were reclaimed. The newly created cloud fixture was recycled with
asynchronous deletion confirmed. No production service or bot connection changed.

These observations do not prove arbitrary external-side-effect rollback, host
failure recovery, all-provider behavior, or real Feishu UI/callback delivery.

## Remaining execution order and decisions

1. Review the open PRs and select the actual release source. Only the user may
   merge; approvals or green CI do not authorize the agent to merge, enqueue,
   push the target branch, tag or publish a final release.
2. Build the reviewable distribution from that source, then perform the explicit
   remote SHA installation and upgrade/rollback gates. Keep production config and
   workspace protected; fresh archive fixtures are not production migration.
3. Complete the remaining deployment and real Feishu UI scenarios. The last
   user-confirmed desktop state is locked/remote-only, so a visible, unlocked
   desktop is needed for the UI portion; repeated window probes do not resolve it.
4. Resolve the target-article failure and establish the required deployment-site
   evidence. Any deferral or acceptance-criteria change requires a user decision;
   a captcha page is not a retrieved article.
5. Re-audit every issue criterion on the chosen source, update the milestone and
   release records, and leave final merge/publication to the user.

The unrelated adapter PR [#5046](https://github.com/hs3180/disclaude/pull/5046) remains
`CHANGES_REQUESTED`: the known whitespace normalization can remove meaningful
first-line indentation. It is excluded from the combined candidate and is not
silently made a prerequisite for this release. Cleanup issue
[#5049](https://github.com/hs3180/disclaude/issues/5049) is tracked separately; its
broader ownership/cleanup requirements remain relevant to all further acceptance.
