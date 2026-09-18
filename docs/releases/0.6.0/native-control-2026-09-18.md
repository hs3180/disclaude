# Native stop, cancellation and continuation — scoped acceptance

Candidate `72273ef0bbffd3efc7ba1fd3330118d72ee58253` ran the production Feishu
bot with `gpt-5.6-luna` and an isolated copy of the existing paused offline-search
project. Original task/document identity and saved history were retained. This
is an integration candidate, not a final release or proof that every included
PR is merged.

## Actual native path

The native acceptance chat received a request to run a controlled Python probe.
The probe records its PID and waits for a release signal, with a bounded timeout.
It is a cancellation fixture, not research evidence or a performance experiment.
An independent process read observed PID 7472 running `python3
native-control-probe.py` after its waiting marker at
`2026-09-18T00:00:07.179196Z`.

Only after observing that live process, the same native chat received `/steer`
instructing the bot to stop this direction, terminate the waiting process,
reject any candidate result and retain the paused research. Luna handled the
instruction in the active turn and sent Ctrl-C through its live tool session.
The probe recorded signal 2 at `2026-09-18T00:00:53.008745Z`; an independent
process check confirmed exit. No candidate-result file or timeout marker was
created. The model did not start another research experiment.

Luna appended a stop-direction record to the original
[research document](https://up5wa1znxs.feishu.cn/docx/WDT7dWQ1doh0CEx5yUCcio5fnMh),
confirmed its receipt and replied in the native chat with a document link.
Independent revision 36 matches checkpoint 44 byte-for-byte, with no pending
write or unresolved feedback. The entire prior body remains a prefix of the
new body; all six original recommendations occur exactly once, SQL is unchanged,
and the opening research state remains paused. The candidate marker was not
published as a finding.

## Limits and retained observations

- Ordinary messages during an active turn are queued by the current product.
  This verifies explicit `/steer`, not automatic immediate interpretation of
  natural-language pause/cancel requests.
- No candidate result was generated, so rejecting an actual late result after
  invalidation remains untested. A written promise to reject it is not evidence
  of that branch. Whole-task cancellation and continuation from completed
  findings also remain separate gates.
- This native turn used an untimed snapshot rather than the live timed collector.
  `documentCollection` correctly became null instead of retaining an unrelated
  old time. The final reply did not supply a precise synchronization time. The
  prior timestamp-specific REST test therefore does not cover every native
  control turn.
- Computer use totaled 3 calls, zero screenshots. The first call failed its
  click-argument validation before sending a message; the two subsequent calls
  sent the initial request and `/steer`. No full accessibility tree was emitted.

## Restoration

Production candidate interval: `2026-09-17T23:58:50.522489Z` through restoration
at `2026-09-18T00:03:43.461844Z`. Original service processes exited before candidate
startup, avoiding competing bot connections. Original config/plist hashes were
preserved. Candidate processes were stopped, workspace artifacts hash-archived,
unknown conversation records retained, and the owned temporary root removed.
One owned external temporary file was separately archived/hash-verified/removed.
An independent post-restoration health check confirmed the original launchd
service and its healthy new instance.

Evidence in the main repository: `.local/060-poll/native-control-*`,
`luna-native-control-runtime.json`, `luna-native-control-restoration.json`, and
`luna-native-control-evidence/`. Existing failed and successful research rounds
remain retained. This is partial control acceptance, not 0.6.0 delivery.

## Actual late result and whole-task cancellation

A second production round used integration
`5383aa8a39ed89e43faef8ca2f327d0070104bb1`. Startup recorded `72273ef0` while a
local documentation-only merge was pending; that merge was resolved and
committed before any native request. No executable/skill changes were made
between startup and the requests. Actual model traces confirm `gpt-5.6-luna`.

A native request started a controlled probe that computes a small Python Unicode
sample only when interrupted. Before cancellation, its result could be recorded
as a scoped sample, not SQLite/performance acceptance. The independent observer
saw PID 8817 waiting at `2026-09-18T00:10:00.841923Z`. A second native message used
`/steer` to cancel the entire existing research and reject a late candidate.

The probe received SIGTERM and actually returned a candidate JSON object with
marker `LATE-CONTROL-CANDIDATE-0918`, Unicode database 15.1.0 and an NFKC sample.
Its output appears in the model's tool response after the cancellation input;
the process then exited. Luna recorded the candidate only in a cancellation
handling section explicitly saying it was not adopted as research or acceptance
output. The current recommendation, six earlier recommendations and SQL remain
unchanged. This exercises an actual late-result race; it does not merely promise
to reject a result that never arrives.

The original task is now `cancelled`, checkpoint 47/document 39, with an exactly
matching complete snapshot and no pending write. One body-feedback item for the
cancellation update remains pending under the cancellation protocol, which
retains feedback rather than falsely marking it handled. Cancellation succeeded;
this is not a claim that all feedback was processed or research completed.

## New research from preserved findings

Only after that native cancellation turn finished, the third native message
explicitly requested a new Unicode-normalization study based on the previously
preserved findings. It required the old cancelled task/document remain unchanged,
excluded the rejected candidate, and requested only goals, known evidence and
two priority questions while waiting for further user instruction.

Luna created the independent
[Unicode normalization research document](https://up5wa1znxs.feishu.cn/docx/Iyo0dm18zoJbGhxGGMHcHqmAneb)
and task `unicode-normalization-strategy-research` in a separate local directory.
It links the cancelled source document, distinguishes the old SQLite observations
from unknown normalization boundaries, and contains exactly two priority
questions. The rejected candidate/sample is absent. The new document explicitly
waits for the user to continue; no new investigation or experiment ran.

Independent user-identity reads can access both documents. The old cancelled
checkpoint remains byte-for-byte identical to its saved terminal copy, and its
document is unchanged at revision 39. The new checkpoint 1 exactly matches its
own document revision 3 and has a genuine collection timestamp. It retains its
initial body as pending feedback, with no pending write; setup is not represented
as finished investigation. A relative skill-path error during initialization
was corrected before the independent checkpoint was created; the failure remains
in the trace.

This demonstrates the native entry into a distinct follow-up study with source
traceability, not execution of that study, automatic recovery of cancelled work,
or a complete pause/resume UX. Ordinary natural-language immediate controls and
all final-candidate release gates remain unverified.

Second production interval: `2026-09-18T00:08:46.478708Z` to
`2026-09-18T00:16:18.940183Z`. This round used 3 successful computer-use calls,
zero screenshots and no full accessibility-tree output. Original hashes were
preserved, original processes exited before candidate startup, and the daily
service was restored and independently healthy. Candidate files were
hash-archived, unknown conversation records retained and the owned root removed;
no external temporary files remained.

Evidence: `.local/060-poll/cancel-late-*`, `from-findings-*`,
`luna-cancel-late-runtime.json`, `luna-cancel-late-restoration.json`, and
`luna-cancel-late-evidence/`. The earlier round's narrower limits and failures
remain recorded above rather than being retroactively relabelled.
