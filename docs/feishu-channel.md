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
   immediately.
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
pnpm exec tsx scripts/feishu-cardkit-rate-limit-bench.mts
```

Keep credentials and tenant-specific measurements outside the repository.
Measured limits vary by tenant and should not be treated as a universal
service quota.
