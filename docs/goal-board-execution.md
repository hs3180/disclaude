# Goal tasks on an existing Base

Default Goal rounds expose `goal_board_task` alongside `run_agent_task` and
`goal_report`. The main agent creates/maintains its board through the existing
lark skill and [nine-field template](task-board.md); no extra SDK/auth backend,
task scheduler or Goal execution budget is introduced.

For each task supply the existing `baseToken`, `tableId`, `recordId`, stable
`taskId` and an operation ID. The actual record must have matching `任务 ID`,
`Goal ID` and nonempty `验收要求` (one criterion per line). Current Goal authority,
Project and criteria are rechecked before effects. The tool accepts no actor,
native worker/reviewer identity, permission preset or supplied artifact hash.

- `execute` takes a task description, claims/project-confirms the known record,
  then awaits an independent native worker and its artifact proposal. Only its
  actual settled execution ID and actual file bytes enter submission history.
- `review` takes the actual latest `submissionId`, launches a different native
  reviewer and persists its criterion evidence after settlement. Rejection
  projects `返工`; use a new operation ID for the repair and next review.
- `get` returns the known operation/result, public claim and review history.
  Current approval rechecks actual files, rather than trusting an old verdict.
- `release` requires actual settled native evidence (or no dispatched native
  work). Unknown starts retain ownership for inspection and reconciliation.

Reuse an operation ID only for identical work. Claim credentials and native
dispatch intent are private and durable before effects. A recovered admitted
operation can only look up its actual original result; missing evidence never
starts a replacement. Unknown Base writes read the known record before any
reconciliation and are never blindly resent. Ordinary Base updates are a
projection; the service claim store controls exclusive ownership.

A `completed` Goal proposal is assessed after all owned work has settled.
Every board task touched in that round must have no held claim, a confirmed
completed board state and a current independent approval of actual file hashes.
This does not watch files after the Goal ends or replace final user acceptance.
