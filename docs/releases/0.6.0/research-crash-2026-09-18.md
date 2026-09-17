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
