# Native in-flight direction stop — scoped acceptance

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
