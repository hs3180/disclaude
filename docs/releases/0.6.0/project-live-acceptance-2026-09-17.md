# Project harness: real Feishu acceptance, 2026-09-17

Tested combined runtime `985f28687e09ec49f12f159ff9a54d7b51685941`, including project-harness PR #5021. These observations describe that combined candidate, not every historical PR revision or a formal release. The user authorized interruption of the production bot. Tests used native Feishu controls and actual production-bot callbacks in the acceptance group.

| Journey | Observed result | Scope boundary |
| --- | --- | --- |
| Project form → non-research build diagnosis → wait → normal restart → reopen → submit B → resume | Two findings committed before waiting; entire task JSON identical after restart. Original card reopened via home. Explicit feedback applied, completion displayed, original findings unchanged. | Fictional diagnosis; no build or repair executed. Normal restart is not abrupt-crash recovery. |
| Natural-language persistent task → autonomous completion → home → reopen → evidence | A58/B71 yielded savings13; actual home and evidence views retained source quote and limitations. | Candidate CLI and service must match. First attempt inherited global0.5.3 CLI, reported unknown project_task, and self-recovered; it is not a clean-path pass. |
| Legacy completed task → association preview → confirm → undo | Preview did not establish association. Confirm linked the previewed directory. Undo cleared association and preview; nine findings, sources, summary, document state, identity and completed status unchanged. | Navigation association only. No populated old file tree was tested; local document-state equality is not a fresh server-side document-content check. |

Task identifiers and detailed timestamps are retained in the linked acceptance comments:

- [Build diagnosis, feedback and normal restart](https://github.com/hs3180/disclaude/pull/5021#issuecomment-5708520284)
- [Natural-language creation and evidence reentry](https://github.com/hs3180/disclaude/pull/5021#issuecomment-5708880960)
- [Legacy association and undo](https://github.com/hs3180/disclaude/pull/5021#issuecomment-5709021174)

For each bounded production round, candidate descendants were stopped before restarting the original daily service. Its health was independently checked, original configuration and launch descriptor hashes were unchanged, and no workspace migration was performed. Evidence records were retained intentionally. No PR was merged by this acceptance work.

## Remaining delivery evidence

- Open-ended investigation with multiple substantive interventions and counterexamples through the new harness.
- New-harness in-flight pause/stop/cancel, result continuation and concurrent-task isolation through actual user controls.
- Abrupt process interruption after a committed checkpoint, followed by actual Feishu reentry and application of the latest document feedback. Isolated process/model/Docx recovery tests are complementary evidence.
- Document permissions, synchronization failures, concurrent edits, uncertain writes, notification failures and their visible recovery behavior.
- Full #4753/#4754 acceptance and overall 0.6.0 delivery. These remain open; historical fixed-stage-runner evidence cannot be relabeled as proof of the new harness.
