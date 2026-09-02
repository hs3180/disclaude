# Codex builtin resource support

The Codex backend discovers bundled `skills/<name>/SKILL.md` and
`agents/<name>/<name>.md` resources through a backend-neutral adapter. It
injects only a compact index into the request; Codex reads the referenced
Markdown when a resource is relevant.

This supports discovery and instruction-based invocation without passing
Claude Agent SDK `plugins: [{ type: "local" }]` options. Claude continues to
use its native local-plugin loading path. Claude-only plugin lifecycle hooks
and SDK-specific APIs are not available to Codex; unsupported capabilities are
therefore omitted rather than preventing Codex startup.
