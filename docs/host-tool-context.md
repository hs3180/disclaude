# Host tool input context

`ToolContext.inputContext` optionally carries the originating input's chat,
actor, message and reply anchor. The Codex app-server adapter snapshots this
binding when it receives each input, validates the active native thread/turn
before dispatch, and gives business tools a frozen copy. Resume and a fresh
app-server process use the new input's binding. A model argument or native RPC
field cannot substitute a different source. Metadata does not enter the tool
schema, registry signature or turn prompt through this bridge.

This is source metadata, not an authorization credential. The service must
establish the input's authenticity, permissions and Project scope before allowing
mutations or delegation. An authenticated transport can still carry host input
that lacks a user identity. Missing context stays absent; transports that do not
implement this binding must not invent an actor or use the latest unrelated
message as fallback. No new business tools are enabled by this change.
