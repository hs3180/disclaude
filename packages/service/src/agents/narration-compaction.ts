/**
 * Payload compaction for mid-turn progress text (decision narration and
 * public commentary).
 *
 * Mid-turn narration is the model's own wording, but upstream gateways can
 * embed raw tool payloads in it: whole JSON arguments (signed URLs, long
 * prompts) and full tool outputs arrive as assistant text frames and would
 * otherwise be relayed to the chat verbatim, one message per tool round.
 * A single 2026-10-16 session flooded 13 input dumps (454-836 chars each)
 * plus 12 output dumps into one Feishu group this way.
 *
 * This module folds oversized payloads to a one-line summary before
 * delivery. It is applied to progress text only — final answers and
 * structured results are never modified — and is a no-op for ordinary
 * narration, so short content is delivered byte-identical.
 *
 * @module @disclaude/service/agents
 */

/** Fenced code block, including the opening ``` line. Unterminated fences
 * (a truncated frame) fold as a block too, so a partial dump cannot slip
 * through just because its closing fence was cut off. */
const FENCED_BLOCK_RE = /```[^\n]*\n[\s\S]*?(?:\n```|$)/g;

export interface NarrationCompactionOptions {
  /** Fold a fenced block when its content exceeds this many characters. */
  maxBlockChars: number;
  /** Fold a single line when it exceeds this many characters. */
  maxLineChars: number;
  /** Characters of payload preview to keep in the fold summary. */
  previewChars: number;
}

export const DEFAULT_NARRATION_COMPACTION: NarrationCompactionOptions = {
  maxBlockChars: 300,
  maxLineChars: 300,
  previewChars: 80,
};

export interface NarrationCompactionResult {
  /** The text to deliver; identical to the input when nothing was folded. */
  text: string;
  /** Whether at least one payload was folded. */
  compacted: boolean;
  foldedBlocks: number;
  foldedLines: number;
}

/** Code-point-safe truncation: never splits a surrogate pair. */
function takePreview(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars ? chars.join('') : chars.slice(0, maxChars).join('');
}

function foldSummary(payload: string, options: NarrationCompactionOptions): string {
  const preview = takePreview(payload.trim().replace(/\s+/g, ' '), options.previewChars);
  const total = Array.from(payload).length;
  return `\u{1F4E6} payload 已折叠（${total} 字符）：${preview}…`;
}

/**
 * Fold oversized payloads in mid-turn progress text to one-line summaries.
 * Fenced blocks over `maxBlockChars` and single lines over `maxLineChars`
 * are replaced by `📦 payload 已折叠（N 字符）：<preview>…`; everything else
 * is passed through unchanged.
 */
export function compactNarrationPayloads(
  input: string,
  overrides: Partial<NarrationCompactionOptions> = {}
): NarrationCompactionResult {
  const options = { ...DEFAULT_NARRATION_COMPACTION, ...overrides };
  let foldedBlocks = 0;
  let foldedLines = 0;

  const blockFolded = input.replace(FENCED_BLOCK_RE, (block) => {
    // Strip the opening ``` line and the closing ``` fence to measure content.
    const lines = block.split('\n');
    const content = lines.slice(1, lines.at(-1)?.trim() === '```' ? -1 : undefined).join('\n');
    if (Array.from(content).length <= options.maxBlockChars) { return block; }
    foldedBlocks++;
    return foldSummary(content, options);
  });

  const output = blockFolded
    .split('\n')
    .map((line) => {
      if (Array.from(line).length <= options.maxLineChars) { return line; }
      foldedLines++;
      return foldSummary(line, options);
    })
    .join('\n');

  return { text: output, compacted: foldedBlocks + foldedLines > 0, foldedBlocks, foldedLines };
}
