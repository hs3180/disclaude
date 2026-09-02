/** Bounded, UTF-8-safe truncation for Feishu text replies (Issues #4693/#4716). */

// Feishu rejects oversized text messages with business error 230025. Keep a
// hard ceiling here even when an operator has an outdated, larger env value.
// This matches the limit advertised by the Feishu channel adapter.
export const FEISHU_PLATFORM_MESSAGE_BYTES = 30_000;
export const DEFAULT_FEISHU_MESSAGE_BYTES = FEISHU_PLATFORM_MESSAGE_BYTES;

// Leave room for Feishu's JSON envelope and encoding differences. This must be
// a fixed platform-safe value, not a percentage of the configured limit.
export const FEISHU_RETRY_MESSAGE_BYTES = 24_000;

export const FEISHU_TRUNCATION_MARKER = '\n\n… [中间内容已截断] …\n\n';

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function takePrefixByBytes(text: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const char of text) {
    const nextBytes = byteLength(char);
    if (bytes + nextBytes > maxBytes) {
      break;
    }
    result += char;
    bytes += nextBytes;
  }
  return result;
}

function takeSuffixByBytes(text: string, maxBytes: number): string {
  const chars = Array.from(text);
  let result = '';
  let bytes = 0;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    const nextBytes = byteLength(char);
    if (bytes + nextBytes > maxBytes) {
      break;
    }
    result = char + result;
    bytes += nextBytes;
  }
  return result;
}

export function truncateFeishuMessage(
  text: string,
  maxBytes = DEFAULT_FEISHU_MESSAGE_BYTES
): string {
  if (maxBytes <= 0) {
    throw new Error('maxBytes must be positive');
  }
  if (byteLength(text) <= maxBytes) {
    return text;
  }
  const markerBytes = byteLength(FEISHU_TRUNCATION_MARKER);
  if (markerBytes >= maxBytes) {
    throw new Error('maxBytes is too small for the Feishu truncation marker');
  }
  const contentBytes = maxBytes - markerBytes;
  const headBytes = Math.ceil(contentBytes / 2);
  const tailBytes = contentBytes - headBytes;
  const head = takePrefixByBytes(text, headBytes);
  const tail = takeSuffixByBytes(text.slice(head.length), tailBytes);
  return `${head}${FEISHU_TRUNCATION_MARKER}${tail}`;
}

export function configuredFeishuMessageBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.FEISHU_MAX_MESSAGE_BYTES ?? '', 10);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, FEISHU_PLATFORM_MESSAGE_BYTES)
    : DEFAULT_FEISHU_MESSAGE_BYTES;
}
