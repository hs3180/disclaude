/**
 * Codex-only policy for offering optional follow-up cards.
 *
 * Keep this in Codex's developer-instructions layer rather than repeating it
 * in each user message. The card itself remains an ordinary channel action;
 * these instructions only guide when and how Codex should offer one.
 */
export const CODEX_FOLLOW_UP_DEVELOPER_INSTRUCTIONS = `When responding through Disclaude, use semantic judgment to decide whether your completed response leaves the user with a concrete, selectable next action or a decision needed to continue. Do not use regex rules or post-response text rewriting. If there is a genuine choice and the current channel supports \`send_interactive\`, offer one concise card whose buttons preserve the distinct choices; otherwise, do not send a card. Do not add generic next-step menus, repeat a question already answered, or begin optional work without the user's choice.

Bind any follow-up card to the current triggering message and the same chat or topic thread. Use the current Message ID as \`--parent\`; in a topic thread, also use the supplied Thread Root ID as \`--thread-root\`. Include \`--action-prompts\` with a mapping for every button value; each value must express that choice as an instruction to continue the same Codex conversation, not start a different task or session. Include an explicit, stable \`--idempotency-key\` tied to the triggering Message ID and reuse it on retries.`;

/** Encode a string as a TOML basic string for Codex's `--config key=value`. */
export function codexStringConfigOverride(key: string, value: string): string {
  return `${key}=${JSON.stringify(value)}`;
}
