# Project task recovery: live document feedback

Status: two real API/model recovery paths passed on macOS ARM64, 2026-09-17.
Runtime source: `feat/060-research-project-ux` at `2355e49c`.
This is partial release evidence, not completion of #4753/#4754 or 0.6.0.

## Scenario and observations

1. Created an isolated bot-owned Feishu Docx through the configured production
   application's API identity. Synthetic material stated A=USD41 and B=USD48,
   with equal deliverables. Read back the complete source before execution.
2. Ran the actual `ResearchManager`, `createResearchRunner` and
   `createDocumentReader` in a separate Node process with the configured Codex
   model and a private task store/workspace. Card delivery was captured locally;
   no competing bot connection or production service was started.
3. Confirmed a real `sleep 30` tool process was active, then SIGKILLed the task
   owner process. All five observed descendant process groups disappeared within
   2.5 seconds without test-side remediation.
4. While the owner was stopped, added a real full-document correction comment:
   B receives a USD14 rebate, final B=USD34; A remains USD41. The comment also
   instructed the task to skip the interrupted wait. No direct manager feedback
   call supplied the correction.
5. A new process reopened the same task as `interrupted` and resumed it. The
   normal document synchronization read the new comment. The real model returned
   A=41, B=34, B cheaper by7, explicitly superseding the original B=48.
6. Verified the matching comment-derived feedback was `applied`, its source key
   identified a document comment, and its disposition referenced actual task work.
   The retained document snapshot included the correction. Live source readback
   and the retained raw body remained equal to the original source.
7. Observed the resumed process groups exit, removed the private task directory
   and local XML draft, and moved only the newly created test document to the
   Feishu recycle bin. The asynchronous delete completed with `deleted=true`,
   `ready=true`, `status=success`. Sanitized acceptance records were retained.

## Evidence boundaries

This verifies a real document API, new comment ingestion after an owner-process
crash, actual model execution, stable task identity and preservation of source
text. No source paragraph was edited and no result was exported. The first task
checkpoint had not committed when the owner was killed, so this does not prove
rollback of external side effects or preservation across a later committed-work
interruption. The separate process-recovery E2E covers persisted prior work with
controlled execution; the two observations must not be conflated.

Card transport was captured: user clicks, visual layout, Feishu reentry and the
production callback path remain unverified for this version. Other providers,
platforms, host failure and source-body edits during downtime require their own
acceptance. The production daily service was not stopped or changed. No PR was
merged and no release was published.

## Later checkpoint with changed body and comment

A second isolated run used local combined candidate
`34d58c7213a4691b10b5054a519c0c9b914ed960` (runtime fingerprint
`8632ca6e4c5c6bdd0c4ff403e498cb8d4e7cfc0ee581c6dd82f2fc2cffb18212`).
It used the same actual manager, runner, document reader and configured Codex
backend, with captured card transport and a new bot-owned synthetic document.

- The real model first committed a completed baseline work item with evidence
  A=USD41 and B=USD48, plus pending comparison work. This two-turn sequence was
  requested by the acceptance task to expose a crash boundary; the product does
  not impose research stages.
- The second turn started a real `sleep 30` tool. The test observed one committed
  checkpoint before SIGKILLing its owner. All five observed descendant groups
  disappeared within 2.5 seconds without test-side remediation.
- While stopped, the test changed only the A quote in the actual document body
  to USD58 and added a real comment granting B a USD14 rebate and skipping the
  interrupted wait. Live API readback verified both changes before recovery.
- A fresh process reopened task `eb03515b-0863-4291-9204-b37dc10a9fb0` as
  `interrupted`. Normal document synchronization, without direct manager feedback
  injection, supplied the body change and comment. The model completed with
  A=58, B=34 and B cheaper by24.
- Assertions compared every previously completed work item with its final
  counterpart for exact equality. The old body remained in document history;
  the final snapshot matched the updated live body. Both body-derived and
  comment-derived feedback were applied, and the comment receipt referenced
  actual work. Final live readback confirmed the task did not modify its source.
- The resumed process groups exited and the private task root was removed.
  The XML draft was removed and the newly created document was moved to the
  recycle bin after verification. Local sanitized observations were retained.

This closes the earlier observation gap for a committed checkpoint followed by
an owner-process crash and changed live body/comment in this configuration.
It does not verify external side-effect rollback, host failure, other providers
or platforms, or real Feishu card clicks/reentry. Production service and bot
connections were unchanged; the full UX release gate remains open.
