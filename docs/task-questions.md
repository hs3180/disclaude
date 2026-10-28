# Waiting for task feedback

`TaskQuestionStore` persists a specific task's public question, original
chat/actor/Project/reply route, actual question-card receipt, first answer and
parent-admission receipt. It does not store private credentials, send messages,
start models or grant authority from identity strings. Its owning service must
authenticate the source/callback and check current authorization before effects.

Prepare a host UUID before delivery. `begin(id, 'delivery')` persists sending
intent and grants `dispatch:true` only once. Confirm the actual message/route;
unknown acknowledgements remain sending/uncertain and never grant a resend.
Reconcile the real card first, including a callback arriving before the outbound
acknowledgement. An unconfirmed question is not proof that the user is waiting.

An answer must match the confirmed question message, actor and chat. Store the
actual card message ID and optional platform callback event ID rather than
inventing a user-message ID. Duplicate answers preserve the first value; a
different answer cannot overwrite it. Delayed send acknowledgements/failures
cannot downgrade an answered card.

After saving the answer, `begin(id, 'wake')` grants one wake attempt. Confirm only
actual original-task/parent admission, not model completion or platform delivery.
Unknown wake acknowledgements need admission reconciliation, not worker replay.
Cancellation blocks new answers/wakes while retaining facts about effects that
were already in flight. Current paused/stopped Goal/Project permissions remain
the host's gate; a saved answer does not bypass them.

One owning process serializes private atomic records across directory aliases.
Restart retains sending/uncertain intent, questions and answers; no time expiry,
polling timer, scheduler, Goal budget or automatic replay is introduced. Other
ready tasks can run independently. Default cards, task selection/idle behavior,
verified callback routing and final platform/package acceptance remain separate.
