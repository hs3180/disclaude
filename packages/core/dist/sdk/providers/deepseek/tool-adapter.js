import { prepareTools } from '../../tools.js';
import { renderToolResult } from '../../tool-result.js';
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment';
import { createHash } from 'node:crypto';
import { assertObjectJsonSchema, assertSupportedJsonSchema, } from '@deepseek-ai/dsh-tools';
/** DSH 0.1.2 has a narrower declaration DSL. Keep constraints enforced. */
function nativeDeclaration(schema) {
    let changed = false;
    const result = {};
    const lengths = [];
    for (const [key, value] of Object.entries(schema)) {
        if (key === 'minLength' || key === 'maxLength') {
            changed = true;
            lengths.push(`${key}=${String(value)}`);
        }
        else if (key === 'properties') {
            const properties = {};
            for (const [name, definition] of Object.entries(value)) {
                properties[name] = nativeDeclaration(definition);
                changed ||= properties[name] !== definition;
            }
            result[key] = properties;
        }
        else if (key === 'items') {
            result[key] = nativeDeclaration(value);
            changed ||= result[key] !== value;
        }
        else if (key === 'oneOf') {
            result[key] = value.map((branch) => {
                const declaration = nativeDeclaration(branch);
                changed ||= declaration !== branch;
                return declaration;
            });
        }
        else {
            result[key] = value;
        }
    }
    if (lengths.length) {
        result.description = [
            schema.description,
            `Host-enforced string constraints: ${lengths.join(', ')}.`,
        ]
            .filter(Boolean)
            .join(' ');
    }
    return changed ? result : schema;
}
/** Register canonical tools directly in the agent-scoped DSH native registry. */
export function registerDshTools(registry, tools, attachments) {
    const prepared = prepareTools(tools).map((tool) => {
        const parameters = nativeDeclaration(tool.inputSchema);
        const outputSchema = nativeDeclaration(tool.outputSchema);
        assertObjectJsonSchema(parameters);
        assertSupportedJsonSchema(outputSchema);
        return { tool, parameters, outputSchema };
    });
    const disposers = [];
    try {
        for (const { tool, parameters, outputSchema } of prepared) {
            const admitted = new Map();
            const mediaKey = (value) => createHash('sha256')
                .update(JSON.stringify(renderToolResult(value).images))
                .digest('hex');
            disposers.push(registry.register({
                name: tool.name,
                description: tool.description,
                parameters,
                output: {
                    schema: outputSchema,
                    render: (_args, value) => {
                        const rendered = renderToolResult(value);
                        const images = rendered.images.length ? admitted.get(mediaKey(value)) : [];
                        if (!images) {
                            throw new Error('Native tool image admission is unavailable');
                        }
                        return [{ type: 'text', text: rendered.text }, ...images];
                    },
                    presentationMeta: (_args, value) => value,
                },
                execute: async (args, context) => {
                    context.signal.throwIfAborted();
                    if (!args || typeof args !== 'object' || Array.isArray(args)) {
                        throw new TypeError('Native tool arguments must be an object');
                    }
                    // Native DSH policy, call identity and cancellation remain native.
                    // Validate the original schema before/after the business callback.
                    const value = await tool.execute(args, {
                        signal: context.signal,
                    });
                    const rendered = renderToolResult(value);
                    if (rendered.images.length) {
                        if (!attachments) {
                            throw new Error('Native tool image admission is unavailable');
                        }
                        const refs = await admitEncodedImages(attachments, rendered.images.map((image) => ({ data: image.data, mediaType: image.mimeType })));
                        context.signal.throwIfAborted();
                        admitted.set(mediaKey(value), refs.map((attachment) => ({ type: 'image', attachment })));
                    }
                    return value;
                },
            }));
        }
    }
    catch (error) {
        for (const dispose of disposers.reverse()) {
            dispose();
        }
        throw error;
    }
    let disposed = false;
    return () => {
        if (disposed) {
            return;
        }
        disposed = true;
        for (const dispose of disposers.reverse()) {
            dispose();
        }
    };
}
