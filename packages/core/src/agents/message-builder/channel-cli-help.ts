/** Channel CLI usage is loaded on demand; message prompts expose only routing and safety boundaries. */
export const CHANNEL_CLI_HELP = `channel Skill / Disclaude channel CLI

Usage:
  disclaude channel <command> [options]

Commands and inputs:
  send_text        Send plain text: --text <text>, --text-file <path>, or stdin.
    --mentions <json> Optional array of {openId, name?}.
  send_file        Send a file: --file <path>.
  send_card        Send a display-only card: --card <json>, --card-file <path>, or stdin.
  push             Push an instruction to a chat agent: --message <text>, --message-file <path>, or stdin.
  send_interactive Send an interactive card with clickable buttons.
    --question <text> | --question-file <path> | question text on stdin
    --options <json> Array of {text, value, type?}; type is primary/default/danger.
    --action-prompts <json> Map each option value to its action description in the same conversation.
    --title <text> --context <text> Optional header and subtitle.
    --thread-root <id> Current topic Thread Root ID; never use the card's own ID.
    --idempotency-key <key> Stable retry key; requires --action-prompts.
    Card JSON on stdin is not supported: stdin becomes the question text.
  request_private_input Request private input for an agent-defined workflow.
    --actor <open-id> --source <message-id>
    --workflow-file <path> | --workflow <json> | workflow JSON on stdin
    Workflow fields: title, description, command, args?, cwd?, env?, timeoutMs?.
    Requires service API authentication; never put the private input in this command.
  help             Show this help message.

Common options:
  --chat <id>      Target chat ID (oc_..., ou_..., or cli-...).
  --parent <id>   Triggering Message ID for reply attribution, including private chats and groups.
  --base-url <url> DisclaudeService REST URL (required unless supplied by the managed environment).
  --api-token <t>  Bearer token (managed agents inherit it automatically).

For a topic card, pass both --parent <current-Message-ID> and --thread-root
<Thread-Root-ID>. Every button action must preserve the choice and continue in
that same conversation. Reuse the same idempotency key when retrying one card;
missing or uncertain delivery acknowledgment is not proof that no card was sent.

Managed agents inherit the current service address/token through
DISCLAUDE_API_BASE_URL / DISCLAUDE_API_TOKEN. Service restarts replace the token; do not reuse
credentials from a previous session.

Private input workflow definitions are public metadata. The command opens a
one-use, five-minute card and returns actionId; this confirms the request, not
workflow completion. Private values enter only through that card, never CLI
flags, files, stdin, or ordinary chat. The workflow reads the value from its
process stdin and verified actor/chat/source metadata from
DISCLAUDE_PRIVATE_CONTEXT; its stdout/stderr are suppressed. You own provider,
endpoint, authorization policy and credential use.

Unknown options are rejected and named; each command accepts only its own
flags plus the common ones above.

Output: one JSON result object on stdout; diagnostics are written to stderr.`;

const ALL_SEND_COMMANDS = ['send_text', 'send_file', 'send_card', 'send_interactive'];

/** A concise capability-aware help pointer; complete flags/examples stay in CLI help. */
export function buildChannelCliHelpGuidance(
  invoke: string = 'disclaude channel',
  options: { enabled?: boolean; sendCommands?: string[] } = {},
): string {
  if (options.enabled === false) { return ''; }
  const sendCommands = options.sendCommands ?? ALL_SEND_COMMANDS;
  const hasCards = sendCommands.includes('send_card');
  const commands = [...sendCommands, 'push', ...(hasCards ? ['request_private_input'] : [])];
  const commandList = commands.map(command => `\`${command}\``).join(', ');
  const cardRouting = sendCommands.includes('send_interactive')
    ? '\nFor interactive cards, also pass --thread-root from metadata in topic threads, never the card ID. Map every button value through --action-prompts to continue the existing conversation, and reuse one --idempotency-key for retries; an uncertain acknowledgment must not trigger a blind resend.'
    : '';
  const privateInput = hasCards
    ? '\nFor private input, use request_private_input with a public workflow definition and current actor/chat/source IDs. Enter the private value only in the one-use card, never CLI arguments, files, stdin, chat or logs. Successful request creation does not mean the workflow finished; read the full help before defining it.'
    : '';
  return `\n## Channel CLI\n\nSupported commands: ${commandList}. For flags and input schemas, run \`${invoke} help\` only when using a command.
Use the current Chat ID and Message ID from metadata for --chat and --parent. Managed agents inherit the current API address/token through DISCLAUDE_API_BASE_URL / DISCLAUDE_API_TOKEN. Do not reuse credentials from another session.${cardRouting}${privateInput}
The CLI returns one JSON result on stdout and diagnostics on stderr; verify the requested outcome.`;
}
