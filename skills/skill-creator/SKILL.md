---
name: skill-creator
description: Create or revise an external skill when the user asks for reusable instructions for a CLI, API or task workflow.
allowed-tools: [Read, Write, Bash]
---

# Author an external skill

Turn the user's task into a focused, reusable prompt. Write the skill directly; this authoring skill has no generator script. Use the user's chosen tools and destination, and ask only for missing information that changes the result.

## Working approach

Start from one realistic request and its observable outcome. Identify the inputs the agent already knows, the external tool it will use, and what demonstrates completion. Inspect the installed tool's help or its official API documentation before describing commands; do not invent a wrapper that only exists in the prompt.

Create a separately maintained `<name>/SKILL.md` with YAML `name` and a specific `description`, followed by the instructions. Keep authentication and provider workflows in that external skill, not in disclaude core or its bundled skills. Prefer a self-contained prompt when existing tools suffice. Add external supporting resources only when the actual task needs them.

Write instructions that resolve decisions the agent would otherwise get wrong:

- What activates this skill, and which inputs or current context it needs.
- Which tool performs each operation and how to verify the result.
- How to recognize missing dependencies, expired authorization, partial success and retryable failures without duplicating mutations.
- Which state persists, who owns it and how the agent resumes the workflow.

Preserve the user's existing authorization and tool choices. Do not make every task require a new approval ceremony, infer permission from a skill example, or turn one provider's rules into host policy. Avoid vague triggers such as “can you…” and instructions that merely repeat generic model capabilities.

## Private input in a disclaude task

The agent defines the workflow implementation for this task and requests its private input using the channel CLI:

```sh
disclaude channel request_private_input --chat <chat-id> --actor <initiator-open-id> --source <source-message-id> --workflow-file <workflow.json>
```

The JSON contains `title`, `description`, `command` and optional `args`, `cwd`, `env`, `timeoutMs`. It describes the workflow, not the private value. Use the managed channel API environment; the service requires API authentication. The user enters the value only in the one-use card. The selected workflow receives it on stdin, with verified initiator metadata in `DISCLAUDE_PRIVATE_CONTEXT`. The CLI result confirms the card request, not the eventual workflow outcome.

The agent owns provider selection, permission decisions, credential exchange and any later persistence. Disclaude binds and delivers input; it does not configure a provider workflow in advance. Shared `.runtime-env` is workspace-wide state across sessions and agents, with concurrent writers and launch-time environment snapshots. Explain those consequences if the external skill elects to use it.

## Worked use case: one external GitHub App skill

For a request such as “create an app for this repository and authenticate its issue workflow,” author **one external skill** covering both creation and authentication. This is an authoring example, not a bundled GitHub App implementation.

The resulting prompt should guide the agent through these decisions:

1. Establish the owning account, target repositories and required operations. Reuse an existing authorized app when appropriate; creating another app is not an automatic prerequisite for authentication. Derive requested permissions from those operations.
2. For a new app, choose GitHub's settings flow or [manifest registration flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). Prepare the app details and explain the concrete registration/installation action. In the manifest flow, validate returned state and exchange the temporary code for app credentials. Keep that callback and credential handling in the external workflow. A successful app registration does not establish that it is installed on the requested repository.
3. Authenticate using the correct identity: an app JWT identifies the app; an installation access token acts on an installation's repositories. Follow the current [JWT requirements](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app) and [installation token exchange](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), rather than guessing token formats or hardcoding expiry from prefixes. The external skill owns key storage, token reuse and renewal. If a user must provide a private value, use the channel workflow above.
4. Verify a read operation against the intended repository using that installation identity. Distinguish absent installation, insufficient permission, expired authorization and rate limiting from success. Perform the requested write only within the user's authorization and verify its actual result. Report identifiers and outcomes without returning credentials.

Keep creation, installation, authentication and the business operation distinguishable within the same prompt so a resumed task can continue at the right stage. Test the prompt against an existing-app request as well as a new-app request; neither should force unrelated registration or duplicate a completed mutation.

## Discovery and validation

For disclaude's project skill discovery, place the chosen external skill under `<workspace>/.claude/skills/<name>/` and verify discovery in a fresh agent turn. Other harnesses use their documented paths. Keep the source separately versioned; do not copy provider-specific skills back into disclaude's bundled directory. A service restart is not a skill installation step.

Check frontmatter, referenced paths, actual CLI help and one representative read workflow. Exercise missing-dependency and missing-authorization cases with synthetic fixtures where practical. Report what was actually tested, including any live step that remains unperformed. Creating a prompt does not prove that a provider integration or registration succeeded.

Existing workspace copies and scheduled jobs survive removal of bundled skills. Migrate their paths explicitly when requested; do not silently delete user installations or recreate removed GitHub authentication inside disclaude.
