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
start a new explicit task if more work is required. Mutate checkpoint state only
through this helper; do not patch its JSON to remove pending feedback or rewrite
history after a parsing mistake. Preserve the faulty snapshot and checkpoint,
report the synchronization problem, and leave dependent work paused until the
snapshot mapping can be reconciled without discarding feedback history.

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

Attempt `ack` before `reconcile` when a pending operation exists. A read-back
that already proves the original receipt must confirm that operation, not turn
its receipt into a new body-feedback item. `reconcile` rejects this case with
`write_already_observed_use_ack` and leaves the checkpoint unchanged; use `ack`
with the same operation ID, version and complete snapshot. Actual missing
receipts, body conflicts and changed comments still permit reconciliation.

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

## End-of-turn synchronization

Every research turn needs its checkpoint synchronized to a final complete
read-back, including a turn that keeps the research active. A successful receipt
`ack` already records that full snapshot: if no document writes follow it, use
that snapshot for the closing check without an extra fetch/sync. Substantive
changes made afterwards leave the checkpoint stale and require fetch/sync.
Compare the saved body/revision with the final read-back. A local `status` read
alone cannot establish that the remote document is current.

Prefer this order within a turn:

1. Recover an existing pending receipt first, then fetch/sync user feedback.
2. Apply the substantive incremental research edits supported by that feedback.
3. Fetch the full body/comments and sync the resulting document. Inspect changes
   against the prior snapshot and this turn's actual writes. The helper records
   own substantive body changes as pending too; explain that verified update in
   its decision, rather than treating it as a new user request or blindly
   declaring every new body version to be your own write.
4. Prepare decisions for the reviewed pending items, export/append the receipt,
   and acknowledge its complete read-back. Do not interleave substantive edits
   between prepare and ack; doing so invalidates the receipt's base body.
5. Inspect pendingWrite and unresolved feedback against the final full snapshot
   saved by ack, or fetch/sync if changes followed it. If
   another edit/comment arrived, either handle it or retain it as pending and
   tell the user what remains. Do not repeatedly rewrite findings just to clear
   a body-feedback item, and do not claim that all feedback is settled when it
   is not. Preserve an unanswered clarification until the user answers.

A final sync of the unchanged acknowledged body adds no new body feedback.
Updating the checkpoint does not itself require another document edit. There is
no need for a self-perpetuating cycle of research edits and receipts.

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

## Collection time and literal writes

For a live read, collect all body/comment/reply pages without shell text
interpolation:

```sh
node /path/to/research-workflow/scripts/collect-feishu-snapshot.mjs DOC_TOKEN bot > collected.json
node /path/to/research-workflow/scripts/state.mjs sync ./research/state.json VERSION < collected.json
```

Use the already-authorized identity (`user` or `bot`), explicitly. The output is
a complete snapshot with original `responses` plus `collection.startedAt` and
`collection.completedAt`. Completion is measured after all pages have been read
and validated; any failed/unsupported/incomplete page fails the collection.
The interval is sequential collection, not an atomic remote snapshot. Saved
response conversion does not manufacture a timestamp. Keep the snapshot file
private: it contains the complete document and comments.

State records `documentCollection` from each successful snapshot. An untimed
legacy snapshot clears that field rather than reusing an unrelated older time.
The helper validates timestamp ordering, not the truth of manually supplied
metadata. Use collector output directly, not a hand-written time.

When publishing the overview, identify the actual collection interval/completion
and source revision, e.g. `本轮意见采集完成：<completedAt>（UTC）；正文版本
<revision>，评论/回复 <count> 条；检查点同步，非实时。` This records the collection
that informed the update, not when the metadata was written. Do not repeatedly
rewrite the document just to chase the timestamp produced by its own read-back.
In the final chat reply show the final confirmed checkpoint's
`documentCollection.completedAt` as the last synchronization time. If a read
fails, retain the prior successful time and display the failure; never advance
it from `date` or the failed request time. An untimed checkpoint has an unknown
time, not today's time.

Use JSON input for targeted overview writes and receipt appends:

```json
{"documentId":"DOC_TOKEN","identity":"bot","command":"str_replace","pattern":"exact prior overview text","content":"new overview with literal `ß`/`ss` and actual newlines","revision":"32"}
```

```sh
node /path/to/research-workflow/scripts/write-feishu-text.mjs < write-input.json
```

Build JSON from files/objects using a quoted heredoc or a structured file tool,
not by substituting document text into shell code. `append` omits `pattern`;
`revision` is optional and forwarded unchanged to the provider. The writer uses
an argument array with no shell, does not overwrite whole documents, and never
retries. On any unknown result read back before deciding whether a retry is
needed. The wrapper does not provide a transaction, remote rollback or guarantee
against concurrent edits. Use the normal complete read-back/ack protocol and
preserve user changes.
