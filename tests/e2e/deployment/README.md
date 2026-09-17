# Deployed project-task acceptance

Run this client as a separate process against an already running candidate deployment. It uses only HTTP, not service source imports or a synthetic controller. The deployment must expose authenticated `/api/project-tasks`, have a configured model, and provide a fresh task context from a real message in the dedicated acceptance chat. Context expires after 30 minutes and is bound to the receiving actor/chat; the client cannot select another actor or directory.

Pass `{ "baseUrl": "http://127.0.0.1:PORT", "apiToken": "...", "context": "...", "timeoutMs": 180000 }` via standard input to `node tests/e2e/deployment/project-tasks.mjs`. Keep credentials out of command arguments and reports. If a private input file is used, restrict its permissions and remove it afterward. Do not reuse another user's or unrelated chat's context.

The client checks authentication, forged actor/context rejection, paused task creation, creation idempotency, stale revision rejection, then executes a bounded fictional comparison through the actual configured model. It independently reads completion, source-backed evidence and the frozen directory. This does not test real Feishu rendering, abrupt process crashes, document editing, concurrent task isolation or model performance.

A JSON report on stdout names passed steps, task/request identity, timestamps and cleanup status without response bodies or credentials. Nonzero exit means failure, including failed cleanup. The client creates no local files or child processes. Its own task is cancelled if necessary and archived; the task record remains as explicit acceptance evidence. If creation has an uncertain outcome or context expires before cleanup, the report says `needs-inspection`; it never claims deletion or process termination it cannot observe. Resolve that named task/request in the test chat before a retry.

`--help` describes the input without requiring credentials. Syntax/help/invalid-input checks are not deployed acceptance. Run this independently from the default unit suite; retain the structured report for the exact deployment source tested.

## Two-task isolation

`project-task-isolation.mjs` uses the same stdin deployment settings. It creates A and B with different fictional values, observes both running, pauses only A, and checks B completes while A remains unchanged. It then submits an A-only correction, checks that feedback does not implicitly resume A, resumes it and verifies B remains byte-for-byte unchanged through the public API. Each task allows one bounded `sleep 30` tool call to make overlap observable. Completed A evidence is checked for retention when present; a pause before its first checkpoint does not prove retention of a non-existent checkpoint. This is same-actor/same-chat task isolation, not cross-user authorization proof or a crash test.

Both owned tasks are cancelled if needed and archived in cleanup. Unknown creation/cleanup fails the report and retains task/request identity for inspection. Syntax/help checks alone do not establish that the scenario passed a deployed system.
