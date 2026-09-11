/**
 * Canonical channel CLI help — single source of truth.
 *
 * Issue #4705: the message builder must expose the full channel CLI usage to
 * the agent so it doesn't invent flags, use stale MCP tool names, omit required
 * args, or call the CLI from the wrong cwd. To keep the in-prompt help and the
 * CLI's own `help` output from drifting, both derive from this one constant.
 *
 * Channel-specific copies (bin/router names, cwd nuances) are produced by the
 * helpers below while keeping the command/flag vocabulary here.
 *
 * @module agents/message-builder/channel-cli-help
 */

/**
 * The canonical channel CLI usage/help text. Mirrors the CLI invocation that
 * owns the implementation (`packages/channel-cli/src/cli.ts`). Consumers render
 * `disclaude channel <command>`.
 */
export const CHANNEL_CLI_HELP = `channel Skill / Disclaude channel CLI

Usage:
  disclaude channel <command> [options]

Commands:
  send_text        Send plain text (--text, --text-file, or stdin).
  send_file        Send a file (--file).
  send_card        Send a display-only card (--card, --card-file, or stdin).
  push             Push an instruction to a chat agent.
  send_interactive Send an interactive card with clickable buttons.
  help             Show this help message.

Common options:
  --chat <id>      Target chat ID (oc_..., ou_..., or cli-...).
  --parent <id>   Optional parent message ID.
  --base-url <url> DisclaudeService REST URL (required unless supplied by the managed environment).
  --api-token <t>  Bearer token when the primary runs with --api-token.

Unknown options are rejected and named; each command accepts only its own
flags plus the common ones above.

Output: one JSON result object on stdout; diagnostics are written to stderr.`;

/** The full send_* command vocabulary, used when a caller does not narrow it. */
const ALL_SEND_COMMANDS = ['send_text', 'send_file', 'send_card', 'send_interactive'];

/**
 * Build the in-prompt channel CLI guidance section.
 *
 * Emits the canonical command vocabulary plus the send-time path constraints
 * an LLM must otherwise guess. Returns an empty string when the channel does
 * not use the CLI (no card support passed in).
 *
 * @param invoke - A renderable `disclaude channel ...` prefix functions should
 *   use (defaults to `disclaude channel`). Callers may pass nothing for the
 *   generic form.
 * @param options - Optional overrides; `enabled=false` suppresses the section.
 *   `sendCommands` narrows the advertised send_* vocabulary to what the channel
 *   actually supports, so this block can't contradict the capability notes the
 *   caller already emitted (e.g. "send_file is NOT supported on this channel").
 * @returns The formatted guidance section for the agent prompt.
 */
export function buildChannelCliHelpGuidance(
  invoke: string = 'disclaude channel',
  options: { enabled?: boolean; sendCommands?: string[] } = {},
): string {
  if (options.enabled === false) {
    return '';
  }
  const sendCommands = options.sendCommands ?? ALL_SEND_COMMANDS;
  // `push` targets another agent rather than this channel's transport, so it is
  // never gated by the channel's send capabilities.
  const commandList = [...sendCommands, 'push'].map((c) => `\`${c}\``).join(', ');
  const fileHint = sendCommands.includes('send_file')
    ? '; \`send_file\` needs \`--file <path>\`'
    : '';
  return `
---

## Channel CLI

Send outbound channel messages with the channel CLI.

- Run the built-in help to see every command and flag:
  \`${invoke} help\`
- Supported commands: ${commandList}.
- Text/content inputs accept a value, a file (\`--{x}-file <path>\`), or stdin${fileHint}.
- Pass \`--chat <id>\` (feishu group \`oc_...\`, p2p \`ou_...\`, or \`cli-...\` session).
- Pass \`--parent <id>\` to keep a topic/thread reply in-thread.
- The CLI talks to the DisclaudeService REST API: pass \`--base-url\` / \`DISCLAUDE_API_BASE_URL\` unless the CLI is launched by a managed agent process; pass \`--api-token\` / \`DISCLAUDE_API_TOKEN\` when the primary runs with \`--api-token\`.
- One JSON result on stdout; diagnostics on stderr.

---`;
}
