# Host input provenance

Accepted raw Feishu user events receive an opaque, process-local reference before they enter ordinary channel routing. Text and media use the same mechanism. Media retain both the internal processing ID (for example `om-source-file`) and the actual platform source ID (`om-source`). The channel handler, input router and ChatAgent preserve the reference into native user input.

`readVerifiedInputSource` can recover the captured facts from that input context. Host shallow snapshots preserve the reference; JSON serialization does not. An independently constructed message, a REST request with matching actor/chat IDs, a bot message, a card action or a restarted/replayed message does not gain this provenance. Changes to the actor, chat, internal source ID or known topic identity invalidate it. The reference is not added to the model prompt or JSON fields.

This records where an input entered the service. It does not grant permission, bind a Project, authorize future messages, or enable a tool. Any privileged execution entry must separately validate current policy, Project and request ownership. Callers must not serialize the reference as a credential or infer trust merely from `runtimeSource` being present. The module is service-private; core only transports an unknown reference without interpreting it.

Tests exercise actual Feishu text/media handlers, both ordinary routing paths through ChatAgent into native user input, JSON copies, scope mismatches and frozen host snapshots. They use local SDK ports and do not establish live platform/model acceptance or default subtask-tool registration.
