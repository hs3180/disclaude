/** JSON media envelope; provider objects and durable attachment admission stay in adapters. */
export interface ToolImage {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
}

export interface ToolMediaResult {
  format: 'disclaude.tool-result.v1';
  data: Record<string, unknown>;
  images: ToolImage[];
}

/** Bound image payloads and keep encoded bytes out of model-facing text. */
export function renderToolResult(value: unknown): { text: string; images: ToolImage[] } {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).format !== 'disclaude.tool-result.v1'
  ) {
    return { text: typeof value === 'string' ? value : JSON.stringify(value), images: [] };
  }
  const result = value as Partial<ToolMediaResult>;
  if (
    !result.data ||
    typeof result.data !== 'object' ||
    Array.isArray(result.data) ||
    !Array.isArray(result.images) ||
    result.images.length > 4
  ) {
    throw new TypeError('Invalid host tool media result');
  }
  let bytes = 0;
  for (const image of result.images) {
    if (
      !image ||
      !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType) ||
      typeof image.data !== 'string' ||
      !image.data ||
      image.data.length > 2_000_000 ||
      Buffer.from(image.data, 'base64').toString('base64') !== image.data
    ) {
      throw new TypeError('Invalid or oversized host tool image');
    }
    bytes += Buffer.byteLength(image.data);
  }
  if (bytes > 6_000_000) {
    throw new TypeError('Host tool image limit exceeded');
  }
  return { text: JSON.stringify(result.data), images: result.images };
}
