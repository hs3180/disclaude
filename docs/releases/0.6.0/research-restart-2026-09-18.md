# Research restart: scoped result and comment identity defect

On 2026-09-18, integrated candidate `9f6cc677` ran two native Feishu research
requests with actual `gpt-5.6-luna` rollouts. The first added a supplied annual
maintenance cost to an existing research document: Birch's first-year total
became 2,900, with a 1,460 difference from Atlas. The document remained ongoing,
with original material and history retained. Receipt acknowledgement succeeded
on actual remote readback with the receipt-boundary fix included.

After the first turn completed, the candidate service was stopped and restarted
with the same workspace. Its instance changed and all nine workspace file hashes
matched. A new chat request asked to recover saved progress, read the same document
and all comments, and avoid repeating completed revisions; it supplied no new facts.
The new Luna session found the checkpoint and correctly reported the current cost
and outstanding hardware/backup/upgrade/labor questions. Independent document reads
before and after recovery had identical content and revision 18. No remote write
was performed by the recovery turn.

Recovery was not a clean pass. The agent first parsed inline body comment references
using only `comment_id`, while the saved checkpoint used `comment_id:reply_id`.
This created a spurious pending entry for the same comment. It then read the full
comment API (one thread, one reply, no more pages), synced the correct mapping,
and directly patched the JSON checkpoint to remove the spurious entry. Preserve
that audit defect rather than count a clean final state as correct recovery.
Both replies also exposed a local checkpoint path as a user link.

The follow-up guidance requires a stable Feishu thread/reply identity mapping,
complete comment API reads, and helper-managed checkpoint mutations; user replies
point to the research document rather than local implementation files. This is a
proposed correction, not a completed model retest. It introduces no task framework
or TASK.md convention.

There were three computer-use calls and no screenshots. The original daily service
was restored with matching configuration/plist hashes and independently verified
health. Candidate files and four model-created temporary JSON files were archived
with hashes and removed after ownership/process checks. The research document is
retained. No PR was merged by the agent. Abrupt crash/unknown-write recovery,
concurrent projects/edits, permission failures and complete release acceptance
remain unproven.

## Comment-identity fix retest

Candidate `1e15e959` includes the stable comment-ID guidance. The previous run's
original pre-restart checkpoint was recovered from its recorded helper output;
its serialized bytes matched the hash captured before restart. Only its research
directory was restored into a new owned workspace. The later manually patched
checkpoint was not used as the starting state.

A fresh native chat request asked Luna to recover the same research and read the
latest document/comments, without mentioning the parser defect. The actual rollout
confirmed `gpt-5.6-luna`. It read the comment API and the separate replies API, both
without further pages, and used the same thread/reply ID as the saved checkpoint.
The only checkpoint change was version 6 to 7 through `sync`: all other fields,
including feedback and pending-write state, remained exactly equal. It did not
patch checkpoint JSON or write to the remote document; independent before/after
reads had identical content and revision 18. The final response gave the correct
2,900 conclusion, outstanding costs, ongoing status and original document link,
without a local checkpoint link.

This is a scoped pass for restoring this saved project with unchanged remote
feedback. It does not establish abrupt-crash recovery, changed/offline/concurrent
feedback handling or multi-project isolation. One UI call, no screenshots. The
original daily service was restored and independently healthy, configuration hashes
matched, and owned workspace plus four temporary response files were archived with
hashes and removed after process/ownership checks.
