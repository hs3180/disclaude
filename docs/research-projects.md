# Project tasks and research capabilities

The Feishu `/project` home lists persistent tasks in the existing project context.
Research is one kind of task. There is no separate `/research` product command,
research mode, or research enablement step. `/project info/use/reset` retain their
working-directory control behavior. Unrecognized slash text, including `/research`,
follows the ordinary message route; it does not open a second product surface.

Ask the ordinary agent to carry out persistent work in the current project. Its
message context advertises the shared project-task capability; the agent can create,
inspect and control a task through the managed channel CLI. There is no keyword
classifier, research-specific prompt route, skill invocation or mode selection.
Short answers do not need to become tasks. `/project` remains the stable place to
reopen tasks, inspect evidence, add feedback and use controls. Its goal/scope/material
form is also available, but is not required for agent-initiated work.

The task API takes a service-issued message context plus an operation, not an
actor/chat/directory chosen by the model. Contexts supplement API authentication,
expire after 30 minutes, and are revoked when the channel stops. They are bounded
in memory and do not survive a service restart; task records do survive. A fresh
user message provides fresh task access. Existing-task operations still validate
creator/chat, and control calls reject stale revisions. Repeated creation with the
same request ID and received message reopens its original task.

The CLI supports create, paginated list (including archive), get and lifecycle
controls. Create saves a paused task and publishes its card; an agent may resume
it using the returned revision when the user requested execution. This is an
execution boundary, not an extra user confirmation requirement. The service
resolves the current project directory and preserves it thereafter. Publishing or
appending results remains an explicit operation. See the
[architecture and acceptance gates](proposals/project-research-convergence.md).

## Storage and compatibility

New installations automatically use
`<configured-workspace>/.disclaude/project-tasks/feishu/<app-namespace>` for task
metadata. The namespace is the first 24 hexadecimal characters of SHA-256 of the
configured Feishu app ID. It separates applications sharing a workspace and stays
stable across restarts. The store opens lazily when tasks are accessed; ordinary
messages do not initialize task files. Task execution uses the directory resolved
by `/project info`, not this metadata directory.

An existing absolute `DISCLAUDE_RESEARCH_PROJECTS_DIR` remains a storage-location
compatibility override. It no longer enables a feature. Keep that setting when
upgrading a deployment with existing records: the service reads those files in
place and does not copy, rename or relocate them. Removing the override does not
import its contents into the default store; any later relocation needs an explicit
data-preserving migration. Use a distinct legacy override per application, as
before. Default namespaces do not retroactively change explicitly configured paths.

New tasks persist the current project directory when the creation form is submitted.
Switching the chat's directory affects new tasks, not existing ones. Reopening,
resuming and result continuations keep the original directory. Missing directories
fail visibly without recreation or fallback.

Legacy records without a binding retain their independent execution directory.
Their idle cards offer association preview, confirmation and undo. Association
only changes project navigation metadata; it never moves files or changes execution
cwd. Confirmation rechecks the directory, revision, user/chat and persisted token.
Old record IDs, card callback payloads, source links and export intents remain
compatible. Internal `research` callback names and JSON fields are retained for
that purpose, not as a user mode. The creator in the original chat still owns
controls; sharing a directory does not grant access to other users' task cards.

## Execution and controls

The harness runs bounded agent turns in the saved directory. Each turn proposes a
checkpoint of work updates, evidence and feedback dispositions, plus continue,
wait-for-user or complete. A simple check can complete in one turn. Work updates
are validated before submission: completed/stopped work cannot be overwritten,
existing evidence cannot be deleted, feedback references must resolve, and pending
work prevents completion. Source field validation is not factual verification.

Pause takes effect when the current turn finishes; cancellation discards that
turn's result. Stopping work discards the in-flight checkpoint, including conclusions
that might depend on the stopped work. New feedback prevents stale completion and
is processed on the next turn. At 12 turns the run pauses for review; a resumed run
receives a fresh budget. Timeout or failure preserves previously committed state.
Disposal requests cancellation; it is not evidence that OS descendants exited.

Tasks persist independently of chat history. Reopening after an unclean exit marks
unfinished work interrupted; recovery requires checking fresh materials/feedback.
Only one process may own a store. An unfinished storage recovery fails closed and
retains the files. Completion, cancellation and archive preserve results. Continuing
from results or a selected finding creates a linked task with its original evidence;
repeated card actions return the same successor.

An optional Docx binding reads text and paginated comments at execution checkpoints,
not in real time. Failures retain the previous snapshot and show an unsynced state.
Completed results may be explicitly appended without replacing source blocks.
Persisted write intent and read-only reconciliation prevent blind retries after an
ambiguous append. Confirmed unchanged exports are excluded from later source reads;
edited fragments remain visible. This is not a transactional collaborative merge.
Wiki/image content is unsupported by this document adapter.

## Validation status

The agent-directed executor has real configured-model evidence: a price check used
one model turn and retained the original directory and result after the chat binding
changed; a non-research build diagnosis waited for a user choice, reopened its store,
applied the choice and completed. The latter uses actual model calls and durable
state, but a store restart is not an OS crash test. Captured card transport does not
establish live Feishu clicks.

The natural-language model integration test uses the normal agent prompt context,
real CLI and authenticated HTTP API to create/start a task. A separate real model
turn executes that task against a randomized project file. This captures card
transport and does not claim real Feishu UI acceptance.

Routing tests cover creation without a research setting, app namespace isolation,
same-app reopening, removal of the dedicated command, retained `info/use/reset`
behavior, legacy callbacks and owner/chat restrictions. Current real UI acceptance
remains pending. Earlier live Feishu evidence belongs to the older implementation;
its [historical record](https://github.com/hs3180/disclaude/blob/788e2661/docs/research-projects.md)
does not prove the changed entry or execution path.

```sh
npm run build
npx vitest run packages/service/src/research packages/service/src/harness packages/service/src/channels/feishu/message-handler.test.ts
DISCLAUDE_E2E_TASK_HARNESS=1 npx vitest run tests/e2e/task-harness.test.ts
DISCLAUDE_E2E_TASK_HARNESS=1 npx vitest run tests/e2e/project-task-cli.test.ts
DISCLAUDE_E2E_RESEARCH=1 npx vitest run tests/e2e/research-project.test.ts
```

The opt-in model tests make configured-backend calls. The optional document case
also needs a dedicated `DISCLAUDE_E2E_RESEARCH_DOCUMENT` URL and Feishu credentials;
export is separately opted in with `DISCLAUDE_E2E_RESEARCH_EXPORT=1`. No test flag
enables a production mode. Normal completed tests reclaim their temporary roots;
unconfirmed model termination retains the path and reports it for inspection.
