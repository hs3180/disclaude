# Feedback checkpoint protocol

Use one state file per research task. Resolve `scripts/state.mjs` relative to this
skill, not the task cwd. State contains document/comment content; keep its
private directory out of source control and channel logs. Commands return one
JSON object and nonzero on failure. Supply JSON on stdin (prefer an input file
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
start a new explicit task if more work is required. Mutate checkpoint state only
through this helper; do not patch its JSON to remove pending feedback or rewrite
history after a parsing mistake. Preserve the faulty snapshot and checkpoint,
report the synchronization problem, and leave dependent work paused until the
snapshot mapping can be reconciled without discarding feedback history.

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
Do not treat a compact/truncated comment summary as complete. For Feishu, collect comment threads and replies through the comment API, not the
body fetch's inline comment references. Flatten each reply to
`{"id":"<comment_id>:<reply_id>","body":"<full reply text>"}`; include the thread's
initial reply as well. Follow both thread and reply pagination before setting
`complete: true`. Reuse this ID mapping after restart: the thread ID alone and
the thread/reply pair identify different checkpoint entries even when text matches.
Compare the mapping with saved comment IDs before calling `sync`; a parser change
is not new user feedback. Edited text changes its fingerprint. Use one
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

`ack` input is `{"operationId":"…","snapshot":{…}}` from a complete read-back.
It requires the exact receipt content, the original body outside it, and unchanged
comment versions for the decisions. For an append at the end only, it also accepts
Feishu Markdown readback adding one separator newline before the heading and
removing the receipt’s final newline. This matches the entire expected document;
it does not trim user content, ignore internal changes or accept duplicate receipts. Only then are decisions committed. Other
new comments discovered in the read-back become pending. Document tools that
normalize Markdown differently may fail this conservative check; use reconcile
rather than declaring success or repeatedly appending.

If the append timed out or execution stopped, first inspect the pending write
and read the remote document. Do not blindly repeat it. If `ack` fails because
of edits or normalization, `reconcile` with the same operation ID and a fresh
complete snapshot records the latest document, keeps decisions pending and
clears the ambiguous operation. Inspect any existing receipt before preparing
new decisions; reconciliation does not undo external writes.

Keep receipt acknowledgement separate from substantive edits: `ack` checks the
original body outside its receipt, so settle or reconcile that receipt before
changing the current summary. After substantive changes, refresh the document
and verify its opening status/recommendation agrees with the latest findings.
Retain historical conclusions as history; an appended revision alone does not
make a stale opening summary current.

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
