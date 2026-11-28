---
name: task-question
description: Ask the user a task question while a Goal turn is running, through the disclaude channel CLI and the running service. Use when the Goal's work cannot proceed without a decision, permission or fact that only the user can supply. The answer only returns through the verified card callback; this skill never submits answers and is not a generic polling or notification tool.
---

# Task questions

Agents ask a task question through `disclaude channel task_question_ask`, not an injected tool (Issue #5591). The service binds the question to the live Goal turn of the current actor, chat and Project before the card is raised: the identity flags are a claim the host verifies against the running Goal bindings, never an authorization, and `--goal` only narrows an ambiguous set. The answer returns only through the verified card callback; the Goal turn waits for it.

Use the CLI supplied by the runtime; otherwise run `disclaude channel task_question_ask --help`. Read its current help for the options instead of invoking a repository-relative script, and inspect `--dry-run` before an uncertain request.

## When to ask

- The Goal's task is blocked on a decision, permission or fact that the task context, Project files and history do not contain. Check those first; do not ask what the Goal already states.
- Ask once, with a self-contained question that names the decision or fact needed. Do not re-ask a question that is already waiting for its answer, and do not turn an ordinary reply into a task question.

## Command

```bash
disclaude channel task_question_ask --chat <chatId> --actor <open-id> --source <message-id> --project-root <absolute path> \
  --question '<one self-contained question>' [--goal <goalId>] [--parent <message-id>] [--thread-root <thread-root-id>]
```

- `--actor` is the requesting user's open_id and `--source` the triggering message ID, both from the current request context. `--project-root` is the Goal's Project root as an absolute path; the service matches all three against the live Goal turn's trusted source.
- `--goal` is optional: pass it only when the same user, chat and Project may have several live Goal turns.
- `--parent` is the message the question card replies to; pass `--thread-root` from the request metadata in topic threads, never the card's own ID.
- `--question <text>`, `--question-file <path|->` or question text on stdin. Prefer a UTF-8 file for long or quoted text; JSON is not involved.

## Result

The CLI prints one JSON object. `{"ok":true,"questionId":...}` means the card was requested, not that the question was answered; read the answer from the verified callback in the conversation, never by polling or by re-sending. A refused request (`ok:false`, HTTP 409) means no live Goal turn of this user and Project admitted it — the Goal may be paused, stopped or belong to another chat — so report that instead of retrying blindly. `503` means the service has no API authentication or no running Feishu channel for this chat. Transport failures carry the usual `CHANNEL_API_*` classification; verify before retrying.

Never submit or fabricate an answer through CLI arguments, files, stdin, chat or logs, and never put private values in the question: the question text is public metadata shown on the card.
