# Direct schedule script lifecycle plan

Related: #4798, #4826. Stacked on PR #4851 (`89a60af9`).

1. Extend the injected `ScriptRunner` contract with an `AbortSignal`, and let
   `Scheduler.stop()` cancel every active script before waiting for drain.
2. Run the real shell in its own POSIX process group so timeout/cancellation
   terminates descendants as well as `/bin/sh`; always drain output and settle
   exactly once.
3. Bound captured stdout/stderr diagnostics and mark truncation. Treat shutdown
   cancellation as neutral; preserve timeout/non-zero exit failure counting and
   cooldown cleanup.
4. Add real-process tests using temporary directories for stdout/stderr,
   non-zero exit, timeout, stop cancellation, and descendant cleanup. No live
   channel, API, or service is used.

The dynamic REST readiness window is intentionally separate: PrimaryNode should
receive the resolved REST base URL before starting Scheduler (or Scheduler
should receive an explicit async environment supplier/readiness dependency).
