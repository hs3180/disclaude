# Feedback checkpoint protocol

Use one state file per research task. Resolve `scripts/state.mjs` relative to this
skill, not the task cwd. State contains document/comment content; keep its
private directory out of source control and channel logs. Commands return one
JSON object and nonzero on failure, except successful `receipt` export emits exact
Markdown. Supply JSON on stdin for mutations (prefer an input file
and shell redirection), never interpolate comment text into shell code.

```sh
node /path/to/research-workflow/scripts/state.mjs init ./research/state.json -1 < binding.json
node /path/to/research-workflow/scripts/state.mjs status ./research/state.json
node /path/to/research-workflow/scripts/state.mjs sync ./research/state.json 0 < snapshot.json
```

`binding.json`: `{"taskId":"research-unique-id","documentId":"doc-token"}`.
The last argument is the version returned by the previous command. Stale
versions fail without writing. The lock is fail-fast; after a worker crash,
verify no owner is alive before manually removing a stale `.lock`. Never steal
an active lock. A cancelled/completed task cannot resume via another mutation;
start a new explicit task if more work is required.

A continuing research revision keeps the existing `taskId` and document binding;
do not rename the task for R5/R6 or patch individual state fields. `state.mjs`
mutations require the saved body to match its hash. A mismatch is a corrupted
checkpoint, not a fresh snapshot: preserve it, report that synchronization cannot
continue, and do not overwrite it with guessed values. Cancellation remains
available to preserve artifacts while stopping further work.

## Snapshot adapter

```json
{
  "documentId": "doc-token",
  "revision": "observed-provider-revision-or-content-hash",
  "body": "complete latest markdown representation",
  "comments": [{ "id": "comment-id/reply-id", "body": "user feedback" }],
  "complete": true
}
```

Fetch body and all comment/reply pages using the installed document/drive CLI.
Do not treat a compact/truncated comment summary as complete. Each comment or
reply has a stable provider ID; edited text changes its fingerprint. Use one
consistent body representation across reads. `complete` attests successful
collection, not just HTTP 200; no fallback to an empty comment list on error.
If no provider revision is available, use a hash of the complete body and
recheck content immediately before writing. This is not a server-side CAS:
concurrent edits can still happen; use append or targeted updates and read-back.

`sync` records changed body as pending feedback (including the initial body),
and each new/edited comment as a separate pending item. It retains earlier
versions for audit; a deleted or superseded comment needs explicit reasoning,
not silent removal. `documentBody` and `comments` retain the latest snapshot.

## Feishu response conversion

Use `scripts/feishu-snapshot.mjs` before `sync` and `ack`. Feed it saved successful
CLI JSON responses, not `jq -r` text piped through `--rawfile`: that path adds a
newline and can fabricate an edit to an unchanged comment. Preserve intentional
newlines too; do not trim user text to compensate.

Input on stdin has `document` (the `docs +fetch --doc-format markdown` response),
`commentPages` (all `drive +list-comments --comment-scope all --solved-status all`
response pages in order), and `replyPages` (one `{commentId, pages}` group per
thread, containing all `drive +list-replies` responses in order). Parse each saved
file with `JSON.parse`, put the resulting objects in this input, and serialize
with `JSON.stringify`; do not extract and retype their body strings.

```sh
node /path/to/research-workflow/scripts/feishu-snapshot.mjs < responses.json > snapshot.json
```

The converter retains the provider document body and reply text byte-for-byte,
uses `comment_id:reply_id`, and rejects missing/failed pages, mismatched document
or thread IDs and duplicate replies. It supports text replies; unsupported rich
content fails explicitly rather than disappearing from a supposedly complete
snapshot. On failure keep the old checkpoint and report what cannot be synced.
It has no remote effects and does not repair already-corrupted checkpoint history.

## Handling and writing back

`prepare` input:

```json
{"decisions":[{"key":"key returned by sync","status":"accepted","reason":"How the plan will change, and why"}]}
```

Other statuses: `needs_clarification`, `not_adopted`. Every decision requires a
reason. The resulting `pendingWrite` has an operation ID, base revision/hash,
and an exact Markdown fragment. Refresh the body and compare to the base before
appending that fragment once. It is a feedback receipt; it does not execute the
research or prove that substantive changes were completed.

Export the prepared fragment without transcription or string reconstruction:

```sh
node /path/to/research-workflow/scripts/state.mjs receipt ./research/state.json 2 > ./receipt.md
```

Use the version returned by `prepare`, not the example's number. This read-only
command emits the saved fragment byte-for-byte, including trailing newlines, and
does not call Feishu or mutate the checkpoint. Check its exit status before
appending the file with the document CLI; never send an error response as content.
Use a relative file path from the CLI cwd, or stdin. Never retype feedback keys,
operation IDs or receipt text: a one-character change prevents acknowledgement.

`ack` input is `{"operationId":"…","snapshot":{…}}` from a complete read-back.
It requires the exact fragment, the original body outside it, and unchanged
comment versions for the decisions. Only then are decisions committed. Other
new comments discovered in the read-back become pending. Document tools that
normalize Markdown differently may fail this conservative check; use reconcile
rather than declaring success or repeatedly appending.

If the append timed out or execution stopped, first inspect the pending write
and read the remote document. Do not blindly repeat it. If `ack` fails because
of edits or normalization, `reconcile` with the same operation ID and a fresh
complete snapshot records the latest document, keeps decisions pending and
clears the ambiguous operation. Inspect any existing receipt before preparing
new decisions; reconciliation does not undo external writes.

Attempt `ack` before `reconcile` when a pending operation exists. A read-back
that already proves the original receipt must confirm that operation, not turn
its receipt into a new body-feedback item. `reconcile` rejects this case with
`write_already_observed_use_ack` and leaves the checkpoint unchanged; use `ack`
with the same operation ID, version and complete snapshot. Actual missing
receipts, body conflicts and changed comments still permit reconciliation.

Once the user clarifies an item, `reopen` with `{"key":"…"}` returns its
`needs_clarification` record to pending; prepare a new decision with the answer
and rationale. `phase` with `{"phase":"synthesis"}` and `finish` with `{}`
require no pending write, pending feedback, or unanswered clarification.
`cancel` with `{}` keeps feedback and any unknown-write record for inspection.

Before changing phase or finishing, fetch/sync again; the local helper cannot
detect external changes without a supplied fresh snapshot. No group creation,
background scheduling, remote transaction rollback or automatic task restart
is implemented by this helper.

## Real integration acceptance (still required)

Use an authorized disposable research document and preset source material.
Have a user edit the scope and comment on one finding; record the AI's revised
plan and receipt, stop/restart the worker and show no duplicate handling. Also
inject an unreadable comment page and a concurrent body edit; neither may
produce a false synced/handled result. Keep this evidence separate from local
fixture tests and preserve the document for review.
