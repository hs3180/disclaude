# Persistent research projects (initial product slice)

The opt-in Feishu project entry is `/research`. It opens a project index and a
creation form; it is a product command, not a skill invocation. Creating a project
shows its scope and controls before any research runs. The user then starts the
project from its card. Planning, investigation and synthesis run independently of
ordinary chat turns through the existing agent runtime.

To enable this slice, configure an absolute `env.DISCLAUDE_RESEARCH_PROJECTS_DIR`
for the service, owned by that service account. Use a different directory for each
Feishu app. The application needs its existing Feishu messaging/card callback
permissions and configured model runtime. This does not change a running deployment
or provision a Feishu application automatically.

Users can reopen `/research` to find existing projects, open findings and sources,
submit adjustments, stop a direction, pause after the current phase, cancel, or
resume an interrupted/failed project. Completion and cancellation preserve results. Finished projects may be archived
from their card, reopened from the archive index, and moved back without deleting
results or changing project identity.
Continuing from results creates a new linked project, with a snapshot of the
previous summary and findings available to its runner. The original remains final.
The finding detail of a completed or cancelled project also offers a continuation
from that specific finding. The new project starts paused, identifies the selected
claim, and preserves its sources and caveats alongside the parent summary. It links
back to both the original project and the selected evidence. Its scope focuses on
that finding rather than repeating the parent plan; parent source/tool restrictions
remain applicable. The original scope is retained as background, and the user can
change the new scope through the adjustment form. Repeating the same
card action returns the same successor; it does not create another project.
When a stage needs a user decision or missing material, the project displays its
question and waits without starting further stages. Submit the answer through the
project adjustment form, then resume; resuming without new input is rejected.
Only the creating user in the original chat may operate the project controls.

Project state is stored independently of chat history. Normal service shutdown
records interrupted work. Reopening after an unclean exit marks unfinished work
interrupted before it can resume. A second live process cannot own the same store.
If storage recovery itself crashes, its `.recovering` guard fails closed; an
operator must verify ownership before clearing that guard. Data files are retained.

Pause and cancel wait for an in-flight phase (bounded by the runner timeout).
Pause retains that phase's result and starts no next phase; cancel discards its
result. A stopped direction's in-flight result is discarded. Feedback arriving
during a phase remains pending for replanning, and feedback during synthesis
prevents final completion until it has been processed. Each pending adjustment requires an explicit acceptance/rejection reason; accepted adjustments link to actual new directions. Missing or duplicated receipts fail the phase without marking feedback applied. Clarification preserves the question on the affected feedback. A plan change remains distinct from a verified conclusion. Card update failures retain
project results and do not re-run completed research; reopening retries delivery.

Projects may bind one Feishu `/docx/` document from the creation form. The app must
have access to its document text and comments. The service reads both before and
after each research phase, including paginated comment replies. Changed text and
comments become pending adjustments that require a disposition in the next plan.
Previous snapshots and findings are retained. Changes received during synthesis
prevent completion until processed. Reopening a finished project does not start
background synchronization; a follow-up project inherits the document binding.

Reads fail visibly on permissions, incomplete pagination, concurrent body changes,
or unsupported/oversized content. The previous snapshot is retained and unread
feedback is never marked processed. Limits are 256,000 raw document characters, 48,000 source body characters, 3,000 per
comment reply, 200 replies, and 64,000 serialized body/comment characters. This
supports text, not Wiki references or image attachments, and checks at phase
boundaries rather than in real time.

A completed project offers an explicit action to append its conclusion, findings,
sources, open questions and feedback decisions to its linked document. Binding a
document alone never authorizes automatic exports. Existing blocks are preserved.
Before writing, the service checks that the source and comments still match the
research snapshot. A mismatch retains both versions and asks the user to continue
research from the results. The export is limited to 50 blocks and 48,000 characters;
oversized results remain available in the project.

The write intent is persisted before the append. If its response or readback is
uncertain, the card offers a read-only reconciliation action; it never blindly
repeats the write, including after restart. An exact, unique fragment confirms the
append. If it remains absent or was edited, reconciliation stays unresolved and
requires inspection of the document. Concurrent edits detected after an append
retain both contents and report a conflict. This is read/append/read verification,
not a server-side compare-and-swap or collaborative merge transaction.

Confirmed, unchanged export fragments are excluded from subsequent source reads,
including linked follow-up projects. Edited or duplicated fragments remain visible
as new source material. This prevents the unchanged report from repeatedly becoming
its own evidence without hiding user changes.

Real Feishu acceptance on 2026-09-16 exercised creation, adjustment, pause/resume,
stopping an in-flight direction, document body changes and explicit append with
independent source-preservation readback. An archived result was reopened from
the archive index and continued as a separate linked project. The successor
inherited the original summary and four findings, accepted new fictional cost
evidence, and produced three new findings. Cancelling during synthesis discarded
the in-flight summary and retained all three findings, still accessible with their
sources through the actual card. The archived original remained unchanged.

This is not the complete #4753/#4754 acceptance. Simultaneously active projects,
interruption recovery with new feedback, remaining collaborative editing/failure
paths, and the newly added per-finding continuation still need real UX acceptance.
Source fields are structurally checked; this is not factual
verification or proof that a model actually consulted a source.

Local checks cover the core lifecycle and actual message-handler/card-action route
using isolated storage and a messaging fixture. They do not claim successful real
Feishu rendering or the full research user journey:

```sh
npm run build
npx vitest run packages/service/src/research/manager.test.ts packages/service/src/channels/feishu/message-handler.test.ts
```

The opt-in model integration test uses the configured backend and real research
runner, with a captured card transport. It creates a project from the actual form
callback, compares two supplied proposals, submits a price-comparison adjustment, checks its linked investigation and retained sources plus a completed
summary, and reopens the persisted result. It makes model API calls; use an isolated
configuration/workspace and test credentials. It does not send Feishu messages or
exercise external source retrieval unless the document case is enabled.

The document case additionally requires `DISCLAUDE_E2E_RESEARCH_DOCUMENT` (a
dedicated test Docx URL), `FEISHU_APP_ID` and `FEISHU_APP_SECRET`. Its fixture is a
document with A priced at USD 10 and B at USD 12, plus a comment correcting A to
USD 15 after tax and confirming B includes tax. It reads real Feishu APIs and
checks that the real model incorporates the comment into its retained conclusion.
By default it does not modify the fixture or send cards. Setting
`DISCLAUDE_E2E_RESEARCH_EXPORT=1` additionally appends a real report and verifies
readback, preservation of the original source, and reconciliation if needed. Use
a disposable document for that case; the report remains after the test. Keep
credentials and document identifiers outside the repository.

```sh
DISCLAUDE_E2E_RESEARCH=1 npx vitest run tests/e2e/research-project.test.ts
```
