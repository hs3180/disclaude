import { createHash } from 'node:crypto';
function record(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function multiline(value) {
    return Array.isArray(value) && value.every((part) => typeof part === 'string')
        ? value.join('')
        : value;
}
function mimeBundle(value) {
    if (!record(value)) {
        return value;
    }
    return Object.fromEntries(Object.entries(value).map(([mime, data]) => [
        mime,
        mime.startsWith('text/') ||
            [
                'application/javascript',
                'image/svg+xml',
                'image/png',
                'image/jpeg',
                'image/gif',
                'application/pdf',
            ].includes(mime)
            ? multiline(data)
            : data,
    ]));
}
function notebookContent(value) {
    if (!record(value) || value.nbformat !== 4 || !Array.isArray(value.cells)) {
        return value;
    }
    return {
        ...value,
        cells: value.cells.map((cell) => {
            if (!record(cell)) {
                return cell;
            }
            const metadata = record(cell.metadata) &&
                cell.cell_type === 'code' &&
                typeof cell.metadata.trusted === 'boolean'
                ? Object.fromEntries(Object.entries(cell.metadata).filter(([key]) => key !== 'trusted'))
                : cell.metadata;
            return {
                ...cell,
                source: multiline(cell.source),
                ...(metadata !== undefined ? { metadata } : {}),
                ...(record(cell.attachments)
                    ? {
                        attachments: Object.fromEntries(Object.entries(cell.attachments).map(([name, bundle]) => [name, mimeBundle(bundle)])),
                    }
                    : {}),
                ...(Array.isArray(cell.outputs)
                    ? {
                        outputs: cell.outputs.map((output) => {
                            if (!record(output)) {
                                return output;
                            }
                            return {
                                ...output,
                                ...(output.output_type === 'stream' ? { text: multiline(output.text) } : {}),
                                ...(record(output.data) ? { data: mimeBundle(output.data) } : {}),
                            };
                        }),
                    }
                    : {}),
            };
        }),
    };
}
/**
 * Logical nbformat content identity across RTC, Contents and saved files.
 * Jupyter's code-cell trust flag is local runtime state; multiline strings can
 * be stored as line arrays. Preserve other metadata and JSON MIME values.
 */
export function notebookSnapshotHash(notebook) {
    const serialized = JSON.stringify(notebookContent(notebook), (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]))
        : value);
    if (serialized === undefined) {
        throw new Error('Notebook snapshot must be JSON content');
    }
    return createHash('sha256').update(serialized).digest('hex');
}
