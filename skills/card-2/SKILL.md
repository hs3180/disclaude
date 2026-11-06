---
name: card-2
description: Author and locally validate native Feishu Card JSON 2.0 with offline component help, editable examples and stable diagnostics. Use when building or fixing a raw card payload before any send decision.
---

# Native Card JSON 2.0 (offline, partial)

All commands run offline through the channel CLI: no chat access, credentials,
message sends or uploads. They validate only the covered subset and never claim
full specification compatibility.

1. Index/search components and fields (JSON on stdout, exit 0):
   - `disclaude channel card_help`
   - `disclaude channel card_help --query fold`
   - `disclaude channel card_help --component collapsible_panel`
2. Start from the editable native example in `skills/card-2/fixtures/metrics-collapsible.json` (metric columns + collapsible detail). It is the same payload `card_help` returns as `examples[0].card`; keep the two in sync when editing.
3. Validate a card offline before any delivery decision:
   - `disclaude channel card_check --card-file path/to/card.json` (also `--card <json>` or stdin)
   - Valid: exit 0, `{"ok":true,"valid":true,...}`.
   - Invalid: exit 1, `{"ok":false,"valid":false,"issues":[{"code","pointer","reason","help"}],"spec":{...}}`.
   - Fix by following `pointer` (RFC 6901) and `help`, then re-run until valid.

Diagnostics use stable `CARD_*` codes (for example `CARD_FIELD_TYPE`,
`CARD_ENUM_INVALID`, `CARD_ELEMENT_ID_DUPLICATE`,
`CARD_COMPONENT_NOT_IN_CATALOG`). Components outside the local catalog are
explicitly "not verified", not "invalid". The result's `spec` block states the
snapshot date, upstream sources, covered rules and not-covered rules; treat
local validity as "covered subset passed", not platform acceptance.

Sending remains a separate decision owned by the `channel` skill; this skill
never sends. Preview and platform acceptance are not implemented in this slice.
