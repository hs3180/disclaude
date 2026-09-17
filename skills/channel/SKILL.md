---
name: channel
description: Send messages, files or specific-feedback cards through the running disclaude service, or push an instruction to an authorized chat. Use for disclaude channel delivery; document editing uses the document tools.
---

# Channel delivery

Use the channel CLI supplied by the runtime; otherwise run `disclaude channel help`. Read its current help for command options instead of invoking a repository-relative script. The CLI connects to the existing service over its REST API; it does not start a service.

Use the chat and thread identifiers from the current request or runtime context. Do not guess a recipient or treat a cross-chat push as permission to perform additional work. Preserve the supplied service address and authentication environment; do not print credentials or switch identities to bypass a delivery denial.

- `send_text` sends a message; `send_file` sends an existing artifact.
- `send_interactive` asks a specific question with options and action prompts. Include enough context to interpret the answer and keep it associated with the original work.
- `send_card` sends a card payload; use it only when that presentation fits the user's request.
- `push` instructs an agent in a chat and can start work; it is not a message-delivery substitute or a status query.

For research, documents and chat carry the findings, evidence and ongoing discussion. Cards can obtain specific feedback, including a choice of useful follow-up questions; they are not a required research dashboard.

Check the CLI's structured result before claiming delivery. When an attempt has an uncertain outcome, inspect the destination or available delivery evidence before retrying to avoid duplicates. A permission or service-unavailable error is not successful delivery.
