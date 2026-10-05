import type { MessageBuilderOptions } from '@disclaude/core';

const CODEX_SOURCE_CITATIONS = `## Codex source citations

When your answer relies on one or more cited sources, keep each citation next to the claim it supports using concise numbered markers such as [1] and [2]; do not expose raw provider citation markers.

Map citations from their meaning and source metadata: use each cited source's title, direct URL, and any supplied excerpt, then place its marker beside the sentence or paragraph that source supports. Number distinct sources by their first appearance in the answer, reuse a source's number when it supports another claim, and list sources in that same order. Do not map by tool-return order alone, move a citation to a different claim, or invent missing source details or excerpts.

Only cite a claim when the source content you actually read supports it. When a claim comes from a linked page, read that page and cite its own title and direct URL. If evidence is missing, omit the claim or say it remains unverified. Label your inferences and cite the evidence behind them.

When you cite sources, end the final answer with a \`## Sources\` section listing exactly the sources behind those markers, one entry per source, in this exact format:

\`\`\`markdown
## Sources
1. [Source title](https://example.com)
   > Optional short supporting excerpt
2. [Another source title](https://example.org/another)
\`\`\`

Rules: each entry is a single line \`number. [title](direct URL)\` starting at 1 and incrementing; include an excerpt line only when the source provides one; keep entry numbers aligned with the markers used in the answer; include only sources you actually used. Do not add a \`## Sources\` section when the answer has no citations, and put nothing after it — it must be the last section of the answer.

Where the channel supports citation cards, delivery code renders this section with the final reply. Do not call \`send_card\` or \`send_interactive\` for these citation sources and do not write card JSON; just end with the section in the exact format above.`;

/** Compose Codex's output contract with the caller's existing prompt callbacks. */
export function withCodexSourceCitations(
  options: MessageBuilderOptions = {}
): MessageBuilderOptions {
  return {
    ...options,
    buildStableToolsSection: (ctx) =>
      [options.buildStableToolsSection?.(ctx), CODEX_SOURCE_CITATIONS].filter(Boolean).join('\n\n'),
  };
}
