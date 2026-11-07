---
name: channel
description: Explicitly deliver files, cards or additional messages through the running disclaude service, or push an instruction to an authorized chat. Use when the task needs a delivery operation beyond the normal conversation reply. Ordinary answers are delivered automatically; document editing uses the document tools.
---

# Channel delivery

In a Disclaude conversation, ChatAgent delivers your final response to the current chat automatically. Answer ordinary questions directly; do not call `send_text` to send the same answer first. Use this skill for an explicit additional delivery, such as an artifact, a feedback card, or an authorized message to another chat. If a delivery tool has already sent content, keep the final reply to any remaining information instead of repeating that content.

Use the channel CLI supplied by the runtime; otherwise run `disclaude channel help`. Read its current help for command options instead of invoking a repository-relative script. Use `disclaude channel <command> --help` for that command, and inspect `--dry-run` before an uncertain delivery. Dry-run validates local input and sends nothing. For interactive JSON, prefer UTF-8 `--options-file` / `--action-prompts-file`; `-` reads stdin for one input only. JSON is parsed once; dense double-escaped Unicode is rejected. The CLI connects to the existing service over its REST API; it does not start a service.

Use the chat and thread identifiers from the current request or runtime context. Do not guess a recipient or treat a cross-chat push as permission to perform additional work. Preserve the supplied service address and authentication environment; do not print credentials or switch identities to bypass a delivery denial.

- `send_text` sends a message; `send_file` sends an existing artifact.
- `send_interactive` asks a specific question with options and action prompts. Include enough context to interpret the answer and keep it associated with the original work.
- `send_card` sends a card payload; use it only when that presentation fits the user's request.
- `push` instructs an agent in a chat and can start work; it is not a message-delivery substitute or a status query.

Executable next-step candidates (Issue #5472): when requested work is complete and you can name a concrete follow-up the user would clearly benefit from running (for example "add the dependency retirement steps to this acceptance flow"), deliver that follow-up as a `send_interactive` candidate card instead of only suggesting it in prose. One button is enough — do not pad extra options to look like a menu. Follow the delivery contract:

- Each option's action prompt is the full, self-contained instruction for the follow-up, targeted at the current session or topic thread. Pass the current request's parent message and thread-root so the click resumes this conversation, and derive an idempotency key from the completed work (e.g. `next-step:<origin message or task id>`) so a retried or duplicated delivery does not produce a second card of the same kind.
- Nothing runs before the click. The card is the offer; the action prompt is executed only when the user selects it. Do not pre-start the follow-up work.
- Do not send such a card when the reply has no beneficial follow-up, when the only next step is a plain confirmation or acknowledgment, when you are waiting for external input that has not arrived yet (e.g. review feedback), when the user asked for strict JSON or code-only output, or on channels without card support — state the suggestion as plain text there instead.

For research, documents and chat carry the findings, evidence and ongoing discussion. Cards can obtain specific feedback, including a choice of useful follow-up questions; they are not a required research dashboard.

Check the CLI's structured result before claiming delivery. When an attempt has an uncertain outcome, inspect the destination or available delivery evidence before retrying to avoid duplicates. A permission or service-unavailable error is not successful delivery.
