import { prepareTools } from '../../tools.js';
import { renderToolResult } from '../../tool-result.js';
/** The namespace is a Codex transport detail, shared by all host-owned tools. */
const HOST_NAMESPACE = 'disclaude';
export function createCodexDynamicToolRegistry(definitions = []) {
    const tools = prepareTools(definitions).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const registered = new Map(tools.map((tool) => [tool.name, tool]));
    return {
        signature: JSON.stringify(tools.map(({ name, description, inputSchema, outputSchema }) => ({
            name,
            description,
            inputSchema,
            outputSchema,
        }))),
        specs: tools.length
            ? [
                {
                    type: 'namespace',
                    name: HOST_NAMESPACE,
                    description: 'Host-owned disclaude tools',
                    tools: tools.map(({ name, description, inputSchema }) => ({
                        type: 'function',
                        name,
                        description,
                        inputSchema,
                    })),
                },
            ]
            : [],
        call: async (request) => {
            const tool = request.namespace === HOST_NAMESPACE ? registered.get(request.tool) : undefined;
            if (!tool) {
                return failure('Requested host tool is not registered');
            }
            try {
                const value = await tool.execute(request.arguments, {
                    signal: request.signal,
                });
                const rendered = renderToolResult(value);
                return {
                    contentItems: [
                        { type: 'inputText', text: rendered.text },
                        ...rendered.images.map((image) => ({
                            type: 'inputImage',
                            imageUrl: `data:${image.mimeType};base64,${image.data}`,
                        })),
                    ],
                    success: true,
                };
            }
            catch (error) {
                return failure(error instanceof Error ? error.message : 'Host tool execution failed');
            }
        },
    };
}
function failure(message) {
    return { contentItems: [{ type: 'inputText', text: message }], success: false };
}
