# Feishu channel

This guide covers app setup and the Feishu features supported by Disclaude.
Keep app credentials private and grant only the scopes required by enabled
features.

## Connect a bot

1. Create an enterprise app in the [Feishu Open Platform](https://open.feishu.cn/)
   or [Lark Developer](https://open.larksuite.com/), then enable its Bot capability.
2. Add the scopes required for the features you use:

   | Capability | Scopes |
   | --- | --- |
   | Receive and send messages | `im:message`, `im:message:send_as_bot`, `im:message:readonly` |
   | Read message attachments; upload images/files | `im:resource`, `im:image`, `im:file` |
   | Read and manage group conversations | `im:chat`, `im:chat:member`, `im:chat:readonly` |
   | Optional reactions or Drive downloads | `im:reaction`, `drive:file:readonly` |
   | Optional group deletion / owner actions | `im:chat:delete`, `im:chat:operate_as_owner` |

3. Under event subscriptions, select **receive events through a persistent
   connection** and subscribe to `im.message.receive_v1`. Subscribe to
   `im.chat.updated_v1` when the app needs group metadata changes to take effect
   immediately. For welcome messages, also subscribe to
   `im.chat.access_event.bot_p2p_chat_entered_v1` and `im.chat.member.added_v1`.
4. Publish the app version, then add the bot to the target chat.
5. Put the App ID and App Secret in `disclaude.config.yaml` and start the service:

   ```yaml
   feishu:
     appId: "cli_..."
     appSecret: "..."
   ```

   ```sh
   disclaude start
   ```

Send `@bot 你好` in a chat to verify the connection. The [root README
quickstart](../README.md#quickstart) covers installation and backend setup.

## Welcome and command help

`/help` lists the registered commands whose runtime dependencies and host access
policy allow them in this conversation. Private chats omit group trigger controls;
topic commands and help replies stay in the current topic. `/agent list` and
`/agent use <name>` appear when named backend/model presets are configured. A
switch starts a new native session. `/steer` appears only when an active query
actually exposes native steer. Attachment guidance reflects the channel's support;
reading or processing a file still requires the model and Feishu permissions.

With the welcome events subscribed, opening a private chat sends a short welcome
once per service run. Bot or member joins share a per-group 24-hour cooldown.
Exact onboarding requests such as `怎么用？`, `不知道怎么开始` or `help` receive
short command guidance, at most once per chat per five minutes across topics.
Normal tasks, ambiguous greetings, quoted messages, attachments, code and explicit
output-format requests continue to the agent. Already actionable task-failure
notices retain their recovery advice. A control-command exception gets a generic
failure notice and, within the same cooldown, a `/help` suggestion; raw exception
details are not sent to the chat.

`/help off` disables automatic welcome and guidance for the whole chat, including
its topics; `/help on` enables them. Explicit `/help` always remains available
subject to the host's access policy. Preferences and rate state are local to the
channel's service run and reset on restart, as the command confirmation states.
State is bounded to 1,000 chats; new automatic prompts are skipped at capacity,
and existing disabled preferences are retained. Failed or uncertain welcome
delivery consumes its cooldown and is not automatically retried.

The optional host `isCommandAllowed` callback uses the same actor/chat/topic
context for command dispatch and help. This does not add user roles or change the
default service permission policy. Anonymous group-join events cannot infer an
individual member's privileges; hosts requiring actor-specific authorization can
deny such automatic help. Native API permission rejection is still authoritative.

## Messages and cards

Disclaude streams replies through Feishu CardKit. Update pacing and retry
handling are managed by the service; a measured tenant limit is not a universal
Feishu guarantee.

`disclaude channel send_card --chat <chat-id> --card-file ./card.json` accepts
legacy cards and static Card JSON 2.0. A minimal 2.0 card is:

```json
{
  "schema": "2.0",
  "config": { "update_multi": true },
  "header": { "title": { "tag": "plain_text", "content": "Report" } },
  "body": { "elements": [
    { "tag": "markdown", "content": "The report is ready." }
  ] }
}
```

For v2 cards, `body.elements` must be an array and a supplied header must
contain a title. Disclaude validates the envelope; Feishu validates
component-specific fields. The card is sent without converting it to the
legacy root `elements` format. See the [Card JSON 2.0 reference](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure).

## Codex input cards

Structured user-input cards are available when the backend is Codex and its
transport is `app-server`:

- A blocking request resumes the originating request with its question IDs.
- A supported non-blocking request is returned as a user message in the
  originating turn; it is not a second request.
- `exec` transport has no interactive request/response path.

Cards are bound to the originating actor, chat, topic, and turn. Stale,
duplicate, incomplete, or out-of-scope submissions cannot answer another
request. For secret questions, the form is sent privately to the actor; answers
are masked and bypass ordinary message logging, prompt generation, conversation
history, and persistent configuration. This cannot constrain how the model
later uses or emits an answer. Never collect credentials in an ordinary,
non-secret question.

## Maintainer rate-limit check

The optional CardKit benchmark is a live experiment, not a CI test. Run it only
against a disposable streaming card whose content may be changed; it requires
a tenant access token with `cardkit:card:write` and the card/element IDs:

```sh
LARKSUITE_CLI_TENANT_ACCESS_TOKEN=... \
CARDKIT_BENCH_CARD_ID=... \
CARDKIT_BENCH_ELEMENT_ID=... \
npx tsx scripts/feishu-cardkit-rate-limit-bench.mts
```

Keep credentials and tenant-specific measurements outside the repository.
Measured limits vary by tenant and should not be treated as a universal
service quota.
