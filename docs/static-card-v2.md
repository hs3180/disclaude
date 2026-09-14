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
