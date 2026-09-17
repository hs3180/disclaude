# Research service crash: partial result and snapshot defect

Candidate `298f40e5` used actual `gpt-5.6-luna` and a preserved research workspace.
A controlled foreground Python read was observed running with a start marker and
no completion marker. Candidate launchd auto-restart was disabled. SIGKILL was sent
to the actual service process, not a test worker. All nine observed service/model/
tool processes exited without manual descendant cleanup within about 0.26 seconds;
the research checkpoint remained byte-identical and no completion marker appeared.

A user body append changed deployment cost to 2,800 while the service was down.
The same workspace was started under a new service instance. The comment creation
attempt had first failed local CLI type validation; after correction, the user
comment changing maintenance to 450 was added before the explicit native resume
request. Thus the two changes were present at resume, but only the body change
was written during actual downtime.

Luna found the saved research and read document revision 27, both comment threads
and their complete reply pages. However, its `jq -r` → `--rawfile` snapshot conversion
added a terminal newline to each string. The unchanged old comment acquired a new
fingerprint and became spurious pending feedback. Raw provider JSON proved that
the newline was introduced locally. The model noticed the discrepancy, then its
upstream connection stalled for 180 seconds. Chat reported the timeout and a
reconnection notice saying the prior request would not be replayed. The R6 revision
was not completed. This is not a successful full crash-recovery acceptance.

The proposed `feishu-snapshot.mjs` consumes saved raw response objects and retains
body/reply strings without shell text conversion, with stable thread/reply IDs and
explicit page/document checks. Captured-response replay against the original
checkpoint produces exactly two pending items: the genuinely new body and comment.
The old comment remains unchanged. Text preservation, multiple pages, missing
pages, identity mismatch, duplicate replies and unsupported content have local
regressions. A complete real-model retest is still required.

Two UI calls, no screenshots. Original production configuration/plist hashes
matched after restoration and independent health passed. Candidate files were
archived with hashes and the owned workspace removed after process checks. The
research document and failed checkpoint remain preserved as evidence; no model
result or user change was silently repaired. No PR was merged by the agent.

## Snapshot-fix model retest: routing bypass, still failed

A fresh Luna run on `4b4812e0` restored the clean R5 checkpoint and received one
native request to finish the existing R6 material. The model read the Lark Docs
skill, but did not load the research skill, invoke the converter or collect the
separate comment/reply API pages. It eventually corrected an initial summary
calculation mismatch and produced consistent current/detail values of 3,250 and
1,810 at remote revision 33, preserving user material and the document link.

Recovery integrity failed: the model directly patched the checkpoint version,
phase, document revision/hash and even changed `taskId` from the R4 identity to an
R6 identity. It left the saved document body at the old revision, so the declared
hash no longer matched it. A correct-looking final document does not establish a
valid persistent recovery record; the converter was not behaviorally verified.

The follow-up adds a contextual route from Lark Docs to the research protocol for
continuing existing document-led research, explicitly retains task identity across
revisions, and rejects mismatched body/hash checkpoints before further mutation.
Cancellation still preserves malformed artifacts. The new regression failed before
the guard; all 16 branch tests pass afterwards, and the actual malformed checkpoint
is rejected in replay. Research skill validation passes; Lark Docs validation has
an unchanged pre-existing unsupported `argument-hint` metadata field. No metadata
was removed to make that validator pass. Another full model retest is required.

One UI call, no screenshots. Original production service restored, configuration
hashes matched and independent health passed. Workspace evidence was archived and
removed after process checks; the malformed checkpoint and remote revision 33
remain preserved. The new checks do not silently repair either artifact.

## Routing and snapshot integrity retest: scoped pass

Candidate `8e2e51a2` resumed a clean R5 checkpoint using actual `gpt-5.6-luna`
and one natural-language chat request. The model located the research protocol,
read revision 33 and both complete comment/reply pages, assembled raw response
objects, ran `feishu-snapshot.mjs`, then called `state.mjs sync` at version 13.
It did not directly patch the checkpoint or repeat the existing R6 document update.

The checkpoint advanced to version 14 with its original task/document identities.
Its saved body hash matches, every old feedback object is unchanged, and exactly
two genuine new feedback entries remain pending: the changed body and R6 comment.
Independent remote readback is identical at revision 33. Chat correctly reports
3,250 (2,800 + 450), outstanding cost uncertainties and the ongoing research.

This verifies real-model protocol routing and snapshot integrity for this resume.
It does not acknowledge the pending feedback or repeat the complete service-crash
sequence on this candidate; those acceptance conditions remain outstanding.
Earlier failed runs and malformed artifacts remain preserved. The integrated
checkpoint/converter suite has 18 passing tests and the build passes; all six
PR CI checks on `cecf6902` passed.

One computer-use call, zero screenshots. Original production service restored
with matching configuration/plist hashes and independent health after 29 seconds.
Owned candidate workspace archived with hashes and removed after process checks.

## Service-crash and feedback settlement retest: scoped pass

Integrated candidate `20e58617` (including PR head `55fce301`) ran actual
`gpt-5.6-luna` with the clean R5 checkpoint. A native request started a foreground
120-second Python read. After observing its PID and start marker, SIGKILL was
sent to the service process. All nine observed processes exited in approximately
0.26 seconds, without descendant cleanup. The checkpoint stayed byte-identical
and the completion marker was absent.

The same workspace restarted under a new service instance. A second native
request asked to resume the original research and settle unrecorded feedback,
without repeating the simulated read or the already-completed R6 conclusion.
Luna read the research protocol, full document and both comment/reply pages,
used the raw-response converter, then performed sync, prepare, append and ack.
The final checkpoint is version 16, document revision 34, active, with no pending
feedback or unknown write. Task/document identities and every old feedback object
are unchanged, and its saved body matches both its hash and independent remote
readback. The entire previous document is preserved with exactly one new receipt.
Chat reports the correct 3,250 total, remaining unknown costs and a stable document
link; the interrupted tool was not rerun.

Two retries remain part of the evidence: the first append was rejected locally
for an absolute `--content @` path before any remote mutation; stdin succeeded.
A wildcard temporary-file cleanup was blocked by automatic review; the model
used new readback filenames and completed safely. No repeated append occurred.
The model's auxiliary task record reports an unsupported 12-minute duration;
measured resume duration was about 171 seconds. That record is preserved, not
used as timing evidence.

This passes in-flight service-crash recovery and settlement of the existing
body/comment deltas on this candidate. Those deltas predated this interruption;
the distinct requirement to add both body and comment feedback during the new
downtime remains unverified. Unknown remote-write recovery, concurrent projects
and the other release gates also remain open.

Two computer-use calls, zero screenshots. The original production service was
restored with matching configuration/plist hashes and independent healthy status
after 23 seconds. Workspace and 16 tool-created temporary files were archived
with verified hashes before removing owned temporary resources. The research
document and historical failed artifacts remain available for review. All six CI
checks passed on `55fce301`; no PR was merged by the agent.
