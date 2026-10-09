/** Bound image payloads and keep encoded bytes out of model-facing text. */
export function renderToolResult(value) {
    if (!value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        value.format !== 'disclaude.tool-result.v1') {
        return { text: typeof value === 'string' ? value : JSON.stringify(value), images: [] };
    }
    const result = value;
    if (!result.data ||
        typeof result.data !== 'object' ||
        Array.isArray(result.data) ||
        !Array.isArray(result.images) ||
        result.images.length > 4) {
        throw new TypeError('Invalid host tool media result');
    }
    let bytes = 0;
    for (const image of result.images) {
        if (!image ||
            !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType) ||
            typeof image.data !== 'string' ||
            !image.data ||
            image.data.length > 2_000_000 ||
            Buffer.from(image.data, 'base64').toString('base64') !== image.data) {
            throw new TypeError('Invalid or oversized host tool image');
        }
        bytes += Buffer.byteLength(image.data);
    }
    if (bytes > 6_000_000) {
        throw new TypeError('Host tool image limit exceeded');
    }
    return { text: JSON.stringify(result.data), images: result.images };
}
