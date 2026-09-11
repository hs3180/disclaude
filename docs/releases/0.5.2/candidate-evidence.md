# 0.5.2 independent-channel candidate

This replaces the withdrawn #4970 integration and `fc74afe03f071bef645845468cb5cc77d5af7064` distribution. Old global-filter and audit acceptance is not evidence for this candidate. This is development acceptance, not a formal tag, deployment or production restart.

## Candidate identity

- Distribution: `d23d5a4db987e096024087bcc809563e8e695908`, branch `release-candidates/0.5.2-channel-release`.
- Runtime source: `ec64bff0c6c2cbf14439c12c65c9bba5cede24a9`.
- Source fingerprint: `9f82308de691619879e15e1da6f83519d74972c3e526565294e88b9ceb527712`.
- Version: `0.5.2`. Source integration branch: `integration/052-channel-release`.
- The candidate generator includes nested runtime sources using the #4963 repair. The fixture pins the distribution SHA; CI checks it against the current source.

## Review map

Review the independent PRs before this aggregate integration. After their merge, rebase the release-only changes and require CI on the resulting HEAD.

| Concern | Changes |
| --- | --- |
| Private input, consumer, verified context and registration | #4953, #4964, #4968, #4969; #4955 is included in #4953 |
| Input/execution/delivery correlation | #4952, #4967 |
| Agent-owned shared environment | #4972 |
| Remove global output classification/filtering from main | #4976 |
| Externalize GitHub auth and workflow skills | #4977, #4978 |
| Generic external skill authoring and runnable scaffold | #4979 |
| Release scope and candidate provenance | #4975, #4963 |

Main already contains the runtime reliability, bounded recovery, compaction, backend failure, delivery visibility and owned-process cleanup fixes. Issues #4916, #4770, #4883, #4898, #4774 and #4927 were closed after their merged implementation and regression evidence were checked. The six remaining milestone issues retain open PR dependencies.

## Acceptance

Build, type check, lint and the full local suite passed: **223 files, 4,683 passed, one CI-only installation wrapper skipped**. Linux CI, macOS Node 20/22 × npm 10/11 installation matrix and pinned upgrade/rollback are being recorded for this exact distribution. Do not infer completion from the old candidate or a different PR head.

Reproduction: `npm test`, `scripts/test-package-install.mjs`, `scripts/test-git-node22.mjs`, and `scripts/test-upgrade-rollback.mjs`. The CI installation gate executes the matrix and upgrade/rollback, using isolated prefixes, configuration and loopback services. The upgrade baseline is 0.5.1 distribution `55cb48616bca0ac08e95af1e0c746f6daddcf982`; direct 0.5.0 upgrade is not claimed.

## Boundaries and remaining evidence

The independent channel verifies its initiator, destination, expiry and one-use bindings, passes the private value only through the configured consumer's stdin, and returns fixed public outcomes. Agent/consumer code owns provider, endpoint and credential lifecycle choices. There is no global sensitivity classifier or logger/CLI/harness filter. #4973 remains a separate delegation-contract discussion; #4895 and #4915 are not release gates.

Feishu callbacks and real consumer children are covered by fixtures. No live private card was sent to another user. The 100-turn cleanup regression uses real child processes with a protocol fixture, not 100 live-model turns. Earlier native two-turn continuation/zero-child and DeepSeek compaction tests retain source `587b85e34778770255e4d1941e072ec9680ac88b`; they were not rerun against this new candidate and do not establish acceptance of its private-channel changes.

The five removed GitHub skills were exported as a historical source snapshot outside this repository. No maintained external skill repository has been published. Users can create replacements with the bundled generic skill creator; existing user workspaces and schedules are not migrated automatically. #4924 remains separately tracked for 0.5.1.
