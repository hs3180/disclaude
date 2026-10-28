# Durable task results

`TaskResultOutbox` stores an actually settled task result before its host tries
to wake the parent. It can be used without Goal or Base. The host supplies the
native task ID, actual chat/Project/actor/source, outcome, summary and artifact
references. The outbox has no task execution or permission mechanism: its owning
service must authorize the scope and the eventual wakeup callback.

`publish(report)` saves a private, immutable result. An exact completion retry
preserves its existing delivery state; conflicting contents for the same task ID
are refused. `get(id)` and `listIds()` permit inspection after restart without
running the task again. Failed or stopped work can retain known partial artifacts.

`deliver(id, send)` saves `sending` before calling the real host callback. A
nonempty confirmed receipt changes it to `delivered`; duplicate/concurrent calls
return the existing receipt without calling `send` again. Unknown or missing
acknowledgements leave `uncertain`. A `sending` record recovered after restart
also requires reconciliation. Neither state is automatically resent. If a result
or receipt publication reports an I/O failure, read back its actual state before
deciding what happened; a failed acknowledgement does not prove the write failed.

Files are atomically published with file/directory synchronization, records use
0600 and the dedicated directory uses 0700. Corrupt, redirected or oversized
records fail closed and remain available for private repair. Use one owning
service process; workers and external CLI processes must use its admitted API
instead of independently opening this store.

This component only preserves completion and delivery intent. It does not journal
unfinished native work, restore workers, establish artifact contents, register a
model tool or wake an actual parent by itself. Background task ownership,
authorization, stable parent admission and the default runtime must compose it
before F5 can be accepted as a product feature.
