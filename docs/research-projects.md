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
prevents final completion until it has been processed. Card update failures retain
project results and do not re-run completed research; reopening retries delivery.

This is not the complete #4753/#4754 acceptance. Materials and feedback currently
come from the project forms. External document edits/comments are not synchronized,
and the UI states this limitation. Collaborative document editing/conflict handling, and live Feishu UX acceptance
remain outstanding. Source fields are structurally checked; this is not factual
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
callback, compares two supplied proposals, checks retained sources and a completed
summary, and reopens the persisted result. It makes model API calls; use an isolated
configuration/workspace and test credentials. It does not send Feishu messages or
exercise external source retrieval.

```sh
DISCLAUDE_E2E_RESEARCH=1 npx vitest run tests/e2e/research-project.test.ts
```
