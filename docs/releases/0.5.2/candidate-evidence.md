# 0.5.2 P0 candidate evidence

This records development acceptance on 2026-09-11. Independent changes remain under review; no formal release/tag, deployment or production restart has been performed.

## Candidate identity

- Distribution: [`fc74afe03f071bef645845468cb5cc77d5af7064`](https://github.com/hs3180/disclaude/commit/fc74afe03f071bef645845468cb5cc77d5af7064), branch `release-candidates/0.5.2-agent-owned`.
- Version: `0.5.2`.
- Runtime source: `a9927a9f3a71cecabae706fd3f3e3975cd5da22f` on the temporary integration branch.
- Source fingerprint: `31e952adcb9b02136500dce46c15a938dd04d9ab2fc57d1ecec5f1af907c7995`.
- [Integration / Linux CI PR #4970](https://github.com/hs3180/disclaude/pull/4970). This draft aggregates independent PRs for verification; review the individual changes first, then rebase release-only changes after they merge.
- [Fingerprint repair #4963](https://github.com/hs3180/disclaude/pull/4963) includes nested runtime source. Earlier candidate checks accidentally omitted `packages/*/src/**`; older installation results are not evidence for this runtime.

## Automated and installed-runtime checks

Combined build, type check, lint and full suite passed: **4,730 passed, one skipped, 224 files**. The local skip is the CI-specific installation wrapper; installations were also exercised directly below.

| Host | Node | npm | Actual Git installation and CLI start/stop/restart |
| --- | --- | --- | --- |
| macOS | 20.20.2 | 10.9.9 | Pass |
| macOS | 20.20.2 | 11.6.0 | Pass |
| macOS | 22.23.2 | 10.9.9 | Pass |
| macOS | 22.23.2 | 11.6.0 | Pass |
| Linux CI | Node 20 / 22 | npm 10 / 11 | [Current-candidate CI gate](https://github.com/hs3180/disclaude/actions/runs/34589655470); require Unit Tests and Test Coverage success |

Same-prefix upgrade and rollback passed on macOS Node 20/npm 10: pinned 0.5.1 distribution `55cb48616bca0ac08e95af1e0c746f6daddcf982` → this 0.5.2 candidate → the same 0.5.1 distribution. Each phase started through the public CLI, returned healthy status, stopped cleanly and released its instance lock. Configuration, `.runtime-env` and a user-data fixture remained byte-identical. This establishes the tested 0.5.1 baseline; direct 0.5.0 upgrade is not claimed.

Reproduction: `scripts/test-package-install.mjs`, `scripts/test-git-node22.mjs`, and the integration branch's `scripts/test-upgrade-rollback.mjs`. The Linux CI installation gate also runs the pinned upgrade/rollback sequence. Every run uses isolated prefixes, configuration and loopback endpoints; none restarts a production service or prompts a live channel.

## Live backend checks on combined runtime

The following live checks used combined source `587b85e34778770255e4d1941e072ec9680ac88b`. The latest candidate adds CLI output protection and shared-environment guidance and removes rejected runtime-policy/skill changes; its backend implementations are unchanged. These live results retain their original source attribution.

Native Codex 0.154.0 used an isolated home/workspace with copied owner-only auth. Turn one invoked a shell tool to write exactly `ready` to `acceptance.txt`; turn two used a new app-server process and recalled `cobalt orchard 052 SECOND_OK`. Both results completed without error. The first process group was absent between turns and all observed groups were absent after the second turn. The 100-turn real-child regression also passes in the combined suite.

DeepSeek `deepseek-v4-flash` through Claude crossed an explicit 100,000-token compaction window using disposable archive rows. Three turns completed, a compaction boundary was observed, a random marker survived, continuation succeeded, and `17 * 19 = 323` was retained. There were no failed turns. The harness explicitly registered its API key for protection during this test.

Local raw reports are `/tmp/052-native-integrated.log`, `/tmp/disclaude-052-compact-integrated-result.json`, `/tmp/052-agent-owned-mac-node20.log`, `/tmp/052-agent-owned-mac-matrix.log`, `/tmp/052-agent-owned-upgrade.log` and `/tmp/052-agent-owned-full-tests.log`. These machine-local paths are provenance references, not durable release assets; CI output and this summary are the shared evidence.

## P0 review map

| Concern | Independent changes / acceptance |
| --- | --- |
| Owned children / forget / resource metrics | #4937, #4940, #4948, #4951, #4957, #4967; 100-turn fixture and native two-turn zero-child boundaries |
| Bounded UNKNOWN recovery / no automatic input replay | #4934, #4938; startup and post-tool failure regressions |
| Compaction / explicit backend failure | #4939, #4943; native/non-native boundaries and live threshold check |
| Private authentication infrastructure | #4946, #4953, #4955, #4958, #4964, #4968, #4969; configured process, verified initiator context, one-use bindings and value-free results |
| Shared environment and agent-owned policy | #4933, #4972; safe file primitives and common sharing/concurrency/snapshot guidance. #4949/#4950 were closed and their changes were removed from this candidate. |
| Explicit diagnostics / visibility | #4930, #4931, #4954, #4956, #4959, #4960, #4962, #4965, #4966, #4971; no sensitivity classifier, declared-value tests across environments and chunk boundaries |
| Input → execution → delivery correlation | #4942, #4945, #4952, #4967; queued-turn receipt tests and per-process frozen context |
| Threat model and supply chain review | #4961; source findings, reachability distinctions and explicit remaining work |

## Open gates and limits

- #4915 remains blocked: the AIvoluation GitHub App has `security_events: read` but no `secret_scanning_alerts` permission. Its repository-scoped token receives HTTP 403 from the real alerts endpoint. Neither that response nor human access to the GitHub UI establishes a successful read.
- Linux installation and upgrade evidence is in the linked CI job. Require every job on the newest HEAD to pass after every rebase or integration update; older green checks are insufficient.
- Feishu transport and configured consumers are tested through real callback/child-process fixtures. No live private card was sent to another user. Installed consumer code owns its authorization, endpoint and credential-exchange policy; disclaude itself sends the original value only through the bound private path.
- Exact-value protection covers harness declarations; transformed/encoded or undeclared copies are not classified. Process groups reclaim ordinary owned descendants, not processes that deliberately escape an OS boundary.
- The development candidate does not imply 0.5.1's separately tracked Docker validation is complete, nor does it authorize a formal 0.5.2 release.
