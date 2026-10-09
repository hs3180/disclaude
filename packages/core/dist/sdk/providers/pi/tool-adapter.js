import { prepareTools } from '../../tools.js';
import { renderToolResult } from '../../tool-result.js';
function result(value) {
    const rendered = renderToolResult(value);
    return {
        content: [
            { type: 'text', text: rendered.text },
            ...rendered.images.map((image) => ({ type: 'image', ...image })),
        ],
        details: value,
    };
}
/** Pi uses its native registry; the business definition stays in tools. */
export function adaptPiTools(definitions = []) {
    return prepareTools(definitions).map((definition) => ({
        name: definition.name,
        label: definition.name,
        description: definition.description,
        parameters: definition.inputSchema,
        execute: async (_toolCallId, params, signal, onUpdate) => {
            const value = await definition.execute(params, {
                signal: signal ?? new AbortController().signal,
                ...(onUpdate
                    ? {
                        onProgress: (progress) => {
                            try {
                                onUpdate(result(progress));
                            }
                            catch {
                                /* Progress is best-effort. */
                            }
                        },
                    }
                    : {}),
            });
            return result(value);
        },
    }));
}
