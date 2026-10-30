# Task admission intents

`TaskAdmissionStore` is private storage owned by one service. The host supplies
an operation key scoped to the real Goal/source and a SHA-256 fingerprint of the
complete request, criteria, Project and reply/board route. A model operation ID
alone is insufficient. Persisted strings do not authenticate or authorize work.

Before claiming a task, call `prepare` and retain its private claim lease. Send
the exact saved owner/claimId and `revision - 1` to the claim store. An unknown
claim acknowledgement can be reconciled with these same credentials after a
restart. Never expose this record or bearer material to a model tool or board.

After confirming ownership, current authority and the actual board projection,
call `beginDispatch`. Only a fresh `dispatch: true` permits one native start.
Save the actual returned handle ID with `confirmDispatch`; this means admission,
not execution success. Real completion belongs in the existing result outbox.

Recovered `dispatching` or `admitted` records never permit another start. Query
the original native task/result and inspect its effects before any explicit
recovery. A missing receipt is not proof that nothing ran. Failed writes retain
the previous record; an uncertain dispatch-write acknowledgement is conservative
and does not grant a retry. This component does not dispatch work, restore an
execution, authorize releases, expire reservations, add a scheduler or budget
Goal execution.
