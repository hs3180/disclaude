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
