# Static Feishu Card JSON 2.0

`disclaude channel send_card --chat <chat-id> --card-file ./card.json`
accepts legacy cards and static `schema: "2.0"` cards. Configure the service
address with `--base-url` or `DISCLAUDE_API_BASE_URL` as for other channel commands.

A minimal report card:

```json
{
  "schema": "2.0",
  "config": { "update_multi": true },
  "header": { "title": { "tag": "plain_text", "content": "Daily report" } },
  "body": {
    "elements": [
      { "tag": "markdown", "content": "**Finding:** the deployment checks passed." }
    ]
  }
}
```

For v2, `body.elements` must be an array; `config` and `header` are optional
objects, and a supplied header must contain `title`. The CLI validates the
envelope; Feishu validates component-specific fields. The schema and body are
forwarded without conversion to the legacy root `elements` format. Unknown
schema versions are rejected explicitly. Legacy card validation is preserved.

Use v2-native components and uploaded image keys in v2 payloads: legacy table
conversion and local-image preprocessing apply only to root `elements` cards.
This command does not register button callbacks or answer requestUserInput.

Reference: [Feishu Card JSON 2.0 structure](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure).

## Live delivery acceptance

The opt-in use-case E2E is `tests/e2e/static-card-feishu.test.ts`, with a static
report fixture containing a header, two columns, a divider and markdown. It
executes the actual channel CLI against an isolated authenticated `HttpApiServer`,
uses the real outgoing `FeishuChannel` implementation, verifies the unchanged
Card 2.0 payload at the Feishu SDK boundary, and reads back the created message.
Incoming WebSocket startup is omitted so this output test can coexist with a
running bot. It does not verify incoming callbacks, visible rendering or a full
service startup. Local message logs use an isolated temporary workspace.

This test **sends one real card** and leaves it in the selected chat. Supply an
explicitly authorized test chat and app credentials outside the repository:

```sh
npm run build
# Set FEISHU_APP_ID, FEISHU_APP_SECRET externally.
DISCLAUDE_E2E_FEISHU_CARD=1 npx vitest run tests/e2e/static-card-feishu.test.ts
```

Also set `DISCLAUDE_E2E_FEISHU_CHAT` to the test group's `oc_...` ID. Without the
explicit enable flag, the case is skipped. No credentials or test chat IDs are
stored in the fixture. The live outgoing chain passed on macOS on 2026-09-16;
279 channel CLI/core tests cover legacy cards, invalid envelopes and transport
behavior. Visual rendering remains a separate observation.
