/** Bounded, UTF-8-safe fallback for Feishu text replies (Issue #4693). */

export const DEFAULT_FEISHU_MESSAGE_BYTES = 1_800_000;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function splitFeishuMessage(text: string, maxBytes = DEFAULT_FEISHU_MESSAGE_BYTES): string[] {
  if (maxBytes <= 0) {throw new Error('maxBytes must be positive');}
  if (byteLength(text) <= maxBytes) {return [text];}
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let end = 0;
    let bytes = 0;
    for (const char of remaining) {
      const next = byteLength(char);
      if (bytes + next > maxBytes) {break;}
      bytes += next;
      end += char.length;
    }
    if (end === 0) {throw new Error('maxBytes is smaller than one UTF-8 code point');}
    const candidate = remaining.slice(0, end);
    const boundary = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf(' '));
    if (boundary > Math.floor(candidate.length * 0.6)) {end = boundary + 1;}
    let chunk = remaining.slice(0, end);
    const fences = (chunk.match(/^\s*```/gm) ?? []).length;
    if (fences % 2 === 1) {
      // Leave room for the balancing fence; never violate the API byte cap.
      while (byteLength(`${chunk  }\n\`\`\``) > maxBytes && chunk.length > 0) {
        const chars = Array.from(chunk);
        const removed = chars.pop() ?? '';
        chunk = chars.join('');
        end -= removed.length;
      }
      chunk += '\n```';
    }
    chunks.push(chunk);
    remaining = remaining.slice(end);
  }
  return chunks;
}

export function configuredFeishuMessageBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.FEISHU_MAX_MESSAGE_BYTES ?? '', 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_FEISHU_MESSAGE_BYTES;
}
