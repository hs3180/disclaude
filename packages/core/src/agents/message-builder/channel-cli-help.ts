import type { ChannelCapabilities } from '../../types/channel.js';

const COMMON_HELP = `Common options:
  --chat <id>       Target chat ID (oc_..., ou_..., cli-..., rest-..., UUID, or user@im.wechat).
  --parent <id>     Triggering Message ID for reply attribution.
  --base-url <url>  DisclaudeService REST URL (required unless supplied by the managed environment).
  --api-token <t>   Bearer token (managed agents inherit it automatically).
  --dry-run        Validate local input and print payload; zero network calls, no send or push.
  --help, -h       Show command help before any required-argument validation.

Managed agents inherit the current service address/token through
DISCLAUDE_API_BASE_URL / DISCLAUDE_API_TOKEN. Service restarts replace the token; do not reuse
credentials from a previous session.

Input/file alternatives are mutually exclusive. A file value of - reads stdin;
only one input may use stdin in one invocation. UTF-8 JSON files avoid shell
quoting/encoding problems. JSON is parsed once: do not double-escape Unicode.
Unknown options are rejected and named; each command accepts only its own
flags plus the common ones above.
Output: one JSON result object on stdout; diagnostics are written to stderr.
A dry-run validates local CLI input only; it does not confirm remote acceptance.`;

const PRIVATE_HELP = `Private input workflow definitions are public metadata. The command opens a
one-use, five-minute card and returns actionId; this confirms the request, not
workflow completion. Private values enter only through that card, never CLI
flags, files, stdin, or ordinary chat. The workflow reads the value from its
process stdin and verified actor/chat/source metadata from
DISCLAUDE_PRIVATE_CONTEXT; its stdout/stderr are suppressed. You own provider,
endpoint, authorization policy and credential use.`;

const INTERACTIVE_HELP = `--question <text> | --question-file <path|-> | question text on stdin
--options <json> | --options-file <path|->
  Non-empty array: [{"text":"Approve","value":"approve","type":"primary"}]
  text/value: non-empty strings; type?: primary | default | danger.
--action-prompts <json> | --action-prompts-file <path|->
  Object, never an array: {"approve":"Continue with the approved work"}.
  When supplied, every option value must map to a non-empty action prompt.
--title <text> --context <text> Optional header and subtitle.
--thread-root <id> Current topic Thread Root ID; never use the card's own ID.
--idempotency-key <key> Stable retry key; requires --action-prompts.
Card JSON on stdin is not supported: default stdin becomes the question text.
When a JSON file uses -, supply question text explicitly or through a file.
--dry-run returns the full payload plus decodedPreview (first 80 characters
of each button label and 120 of each action prompt). Dense literal \\uXXXX sequences are rejected as likely
second-level escaping; use single JSON escaping or raw UTF-8 in files.

Examples (replace IDs; remove --dry-run only when delivery is intended):
  disclaude channel send_interactive --dry-run --chat oc_xxx --question 'Continue?' --options '[{"text":"Approve","value":"approve","type":"primary"}]'
  disclaude channel send_interactive --dry-run --chat oc_xxx --parent om_trigger --thread-root om_topic --idempotency-key 'followup:om_trigger' --question 'Next step?' --options '[{"text":"Continue","value":"continue"}]' --action-prompts '{"continue":"Continue the current work with this choice"}'

For a topic card pass both --parent <current-Message-ID> and --thread-root
<Thread-Root-ID>. Button actions continue in that same conversation. Reuse the
same idempotency key for retries; uncertain acknowledgment is not proof that no
card was sent.`;

const COMMAND_HELP: Record<string, string> = {
  capabilities: 'Read actual active channel capabilities without sending.\n--chat <id> Optional: filter to the channel that owns this peer.\nAn empty result means no active channel owns this chat. WeChat replies use private saved context; omit --parent.',
  send_text: 'Send plain text.\n--text <text> | --text-file <path|-> | stdin\n--mentions <json> Optional array of {openId, name?}.',
  send_file: 'Send an existing file.\n--file <path> Required file path.',
  send_card: 'Send a display-only card.\n--card <json> | --card-file <path|-> | card JSON on stdin\nCard must be a JSON object. Dry-run does not upload or resolve images.',
  push: 'Push an instruction to a chat agent.\n--message <text> | --message-file <path|-> | stdin\nA real push can start work; dry-run never starts an agent.',
  send_interactive: INTERACTIVE_HELP,
  request_private_input: `Request private input for an agent-defined workflow.\n--actor <open-id> --source <message-id>\n--workflow <json> | --workflow-file <path|-> | workflow JSON on stdin\nWorkflow fields: title, description, command, args?, cwd?, env?, timeoutMs?.\nRequires service API authentication; never put the private input in this command.\n\n${PRIVATE_HELP}`,
};

export function getChannelCliCommandHelp(command: string): string | undefined {
  const name = command === 'push_to_agent' ? 'push' : command;
  const details = COMMAND_HELP[name];
  return details ? `Usage: disclaude channel ${name} [options]\n\n${details}\n\n${COMMON_HELP}` : undefined;
}

/** Complete help is loaded on demand; prompts contain only a concise pointer. */
export const CHANNEL_CLI_HELP = `channel Skill / Disclaude channel CLI

Usage:
  disclaude channel <command> [options]

Commands and inputs:
  capabilities     Discover active channel capabilities; optional --chat <id>. Read-only.
  send_text        Send plain text: --text <text>, --text-file <path>, or stdin.
  send_file        Send a file: --file <path>.
  send_card        Send a display-only card: --card <json>, --card-file <path>, or stdin.
  push             Push an instruction to a chat agent: --message <text>, --message-file <path>, or stdin.
  send_interactive Send an interactive card with clickable buttons.
  request_private_input Request private input: --actor <open-id> --source <message-id> --workflow <json> | --workflow-file <path|-> | stdin.
  help             Show this help message.
Run disclaude channel <command> --help for complete command inputs.

send_interactive:
${INTERACTIVE_HELP}

${COMMON_HELP}

${PRIVATE_HELP}`;

const ALL_SEND_COMMANDS = ['send_text', 'send_file', 'send_card', 'send_interactive'];

/** Explicit CLI vocabulary wins; absent lists use the channel's format flags, never an MCP surface. */
export function getSupportedChannelSendCommands(capabilities?: ChannelCapabilities): string[] {
  const supported = capabilities?.supportedChannelTools;
  return ALL_SEND_COMMANDS.filter(command => {
    if (supported !== undefined) { return supported.includes(command); }
    if (command === 'send_file') { return capabilities?.supportsFile === true; }
    if (command === 'send_card' || command === 'send_interactive') { return capabilities?.supportsCard === true; }
    return true;
  });
}

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
    ? '\nFor interactive cards, read send_interactive --help and inspect --dry-run before delivery. Prefer UTF-8 JSON files with one JSON encoding layer. Also pass --thread-root from metadata in topic threads, never the card ID. Map every button value through --action-prompts to continue the existing conversation, and reuse one --idempotency-key for retries; an uncertain acknowledgment must not trigger a blind resend.'
    : '';
  const privateInput = hasCards
    ? '\nFor private input, use request_private_input with a public workflow definition and current actor/chat/source IDs. Enter the private value only in the one-use card, never CLI arguments, files, stdin, chat or logs. Successful request creation does not mean the workflow finished; read the full help before defining it.'
    : '';
  return `\n## Channel CLI\n\nSupported commands: ${commandList}. For flags and input schemas, run \`${invoke} help\` only when using a command.
This list describes channel delivery, not all backend tools. For local Project files, use available native file or execution tools (Codex: exec_command) in the current working directory. /project use selects that directory; local-file requests do not require a cloud Project link.
Use the current Chat ID and Message ID from metadata for --chat and --parent. Managed agents inherit the current API address/token through DISCLAUDE_API_BASE_URL / DISCLAUDE_API_TOKEN. Do not reuse credentials from another session.${cardRouting}${privateInput}
The CLI returns one JSON result on stdout and diagnostics on stderr; verify the requested outcome.`;
}
