# Shared execution history concurrency acceptance

Scope: PR #5111, source `c8471f770fc9f3bca951afa1ecff575c7cce9625`.
This is the existing monthly execution history, not TASK.md or a reusable
sustained-execution feature. It does not certify full 0.6.0 delivery.

## Original failure

The preceding real Luna concurrent research run used integration source
`ef1a110b3ca3f5e875a0f0d84be9bde4aeb36432`. Project B used Add File to write the
shared monthly record at 2026-09-17 21:33:27 UTC; project A used Add File on the
same path at 21:36:59 UTC. The final file retained only A. B's original entry was
recovered separately from its immutable rollout; the failed file was not repaired
to make the original acceptance appear successful.

## Candidate verification

On 2026-09-17 at 22:10–22:12 UTC, a separate loopback REST-only candidate ran two
project-bound `gpt-5.6-luna` sessions. Both foreground tool processes were observed
alive concurrently before the observer released them. No Feishu channel or
competing bot connection was started. An initial launch correctly refused the
production PID lock; the terminal attempt was retained, and the next launch used
its own lock path.

Both models used the helper from this candidate's compiled core directory,
without an instruction in the task prompt specifying that helper's syntax:

| Project | Append time (UTC) | Retention |
| --- | --- | --- |
| A | 22:11:34.646 | Exact submitted entry present once |
| B | 22:11:35.265 | Exact submitted entry present once |

The one shared monthly file has one heading and both complete entries. Neither
project created a private task-records directory. Both result files retain their
own source markers and expected calculations. Rollout turn contexts confirm Luna
for both sessions. This verifies the recording path and preservation of submitted
content in this run; it is not a guarantee that a model can never bypass guidance.

The original harness failed its stricter content assertion: A's execution record
said that it preserved the source marker without including the literal
`RECORD_A_4217`, although A's result file contained it. B included its literal
marker in both places. This omission remains a failed prompt requirement; the
harness failure was not erased or relabeled as a complete pass. A separate
byte-for-byte comparison established that neither submitted record was lost.
Both records reported actual elapsed time as unknown rather than inventing it.

The owned candidate exited, its PID lock was removed, and no open files remained
under its evidence directory. The daily service kept its original PID and
instance ID and passed an independent health check. Computer-use calls: **0**;
screenshots: **0**. Local runtime, rollout references, hashes, and verification
results are retained under `.local/060-poll/record-luna-retest-*`.

## Automated verification

- Full build, changed-source lint, and 114 related tests passed.
- Independent CLI processes retained 16 records over two waves, including first
  file creation and append to existing history, from two project directories.
- 32 simultaneous store calls retained their entries and one heading.
- Invalid input made no record files; legacy history remained unchanged.
- Generated release CLI and runtime-pinned guidance worked from a path containing
  spaces and a quote; temporary release artifacts were removed.
- All 12 CI checks passed on `c8471f77`, including package installation, unit tests,
  service lifecycle, workspace restart, and Linux browser checks. Those checks do
  not replace real research or native Feishu UX acceptance.
