# 0.5.2 final validation

Validated on 2026-09-11 after the agent-defined channel CLI workflow and prompt-only skill authoring revisions. Earlier candidates do not establish acceptance of this scope.

## Exact artifact identity

- Source: `cd616c6e977642e65a5276d3b104e92534a12b3d`.
- Runtime fingerprint: `af15453846c97b088bb0fb8d4fef29eb4b3f2bb98ea6d410253001cd2ae6ac2b`.
- Generated Git distribution: `11b928a2f38f0ca0d81e24c3f0dc79dd6bf896ac`, branch `release-candidates/0.5.2-final`.
- Archive: `disclaude-0.5.2.tgz`, 728933 bytes, 314 files.
- Archive SHA-256: `dc9ed43865d6173502ea6037eb47932ed1aba10629e1516e66f2d6e2e6256d6a`.

This is an explicit release-time artifact, not a tracked candidate fixture or a requirement to regenerate candidates for PRs. This evidence document was completed after artifact generation; the artifact contains the earlier in-progress evidence page. Subsequent evidence-only commits do not change the tested runtime. A newly generated formal release archive must be identified and checked separately.

## Completed local acceptance

| Check | Result |
| --- | --- |
| Build, TypeScript, ESLint | PASS, Node 20.20.2 / npm 10.9.9 |
| Full suite | PASS: 224 files, 4688 tests passed, 1 CI-only install check skipped locally |
| Actual remote Git install on macOS | PASS: Node 20.20.2 and 22.23.2, each with npm 10.9.9 and 11.6.0; isolated install, version/fingerprint, CLI start/stop/restart |
| Same-prefix upgrade and rollback | PASS: 0.5.1 → 0.5.2 → 0.5.1; configuration, `.runtime-env` and user data preserved |
| Installed private-input CLI | PASS: actual packaged CLI → authenticated local HTTP service → workflow consumer stdin; verified actor/source context, wrong-actor rejection, replay rejection and no value reflected in CLI/card output |
| Native Codex live continuation | PASS: two turns, file creation and recall after a new app-server; zero remaining managed processes between turns and after completion |
| DeepSeek live compaction | PASS: deepseek-v4-flash, explicit 100000-token window; compaction occurred, marker retained, continuation and arithmetic correct, three completed turns and zero failed turns |
| Prompt-only skill | PASS: metadata validation and actual built-in discovery; single external GitHub App creation/authentication skill example |
| Distribution inventory | PASS: five removed GitHub skills absent; authoring prompt present; old creation script, local configuration, `.runtime-env`, `.local`, and fixed candidate fixture absent |

The private-input acceptance used a synthetic card transport/callback with the installed runtime, real HTTP and real child process; it did not send a live Feishu card. Backend credentials were supplied only in isolated local acceptance environments and are not part of the artifact or evidence bundle.

## CI and review gates

The independent prompt authoring change [#4983](https://github.com/hs3180/disclaude/pull/4983) is merged as `8f9efce9c77a510da258bb16ef9f1cb8b994c533`. On 2026-09-12, the release branch synchronized that main commit without runtime changes. Its runtime fingerprint remains the exact value above. [#4980](https://github.com/hs3180/disclaude/pull/4980) now contains only six release-preparation files; no feature dependency remains.

[CI run 34613059761](https://github.com/hs3180/disclaude/actions/runs/34613059761) passed all four checks on `775c133103e79847a2bda50f3b1406412b610a31`: lint/type, unit, build and coverage. Linux passed 224 files and 4689 tests with zero skips, including the real-child 100-turn cleanup fixture. Checkout-generated archive installation and CLI start/stop/restart passed on Node/npm pairs 20.20.2/10.8.2, 22.23.2/11.6.0, 20.20.2/11.6.0 and 22.23.2/10.9.9. This is distinct from the actual remote Git installation verified above.

Require the synchronized PR HEAD's four CI checks before merging; the final run identity is recorded in the PR and release handoff after this documentation commit. No fixed candidate fixture is maintained. The reviewed distribution remains unchanged; synchronizing identical runtime content does not require a replacement distribution.

## Scope and limits

No formal tag, release publication, deployment, production restart, Docker acceptance or live private card was performed. Provider policy and credential lifecycle remain agent/external-skill responsibilities. No global sensitivity classifier, comprehensive security audit, task capability grant implementation (#4973), or Secret Scanning permission gate is claimed. Supported release acceptance here covers Node 20/22; it does not claim an exhaustive matrix of every version allowed by the package engine range.
