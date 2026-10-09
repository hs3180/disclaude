import Ajv from 'ajv';
import { renderToolResult } from './tool-result.js';
function assertJson(value, seen = new Set()) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return;
    }
    if (typeof value !== 'object' || seen.has(value)) {
        throw new TypeError('Host tool values must be finite, acyclic JSON');
    }
    if (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) {
        throw new TypeError('Host tool values must be plain JSON objects');
    }
    seen.add(value);
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
        assertJson(item, seen);
    }
    seen.delete(value);
}
function validate(validate, value, kind, ajv) {
    assertJson(value);
    if (!validate(value)) {
        // Non-verbose Ajv errors describe constraints, not argument/result values.
        throw new TypeError(`Invalid host tool ${kind}: ${ajv.errorsText(validate.errors)}`);
    }
}
/** Prepare one query's registry before dispatch. Validation never coerces or mutates values. */
export function prepareTools(tools = []) {
    if (tools.length === 0) {
        return [];
    }
    const names = new Set();
    const ajv = new Ajv({
        strict: true,
        coerceTypes: false,
        useDefaults: false,
        removeAdditional: false,
    });
    return tools.map((tool) => {
        if (!/^[a-z][a-z0-9_]*$/.test(tool.name) || names.has(tool.name)) {
            throw new TypeError(`Invalid or duplicate host tool name: ${tool.name}`);
        }
        names.add(tool.name);
        if (typeof tool.description !== 'string' ||
            typeof tool.execute !== 'function' ||
            tool.inputSchema?.type !== 'object') {
            throw new TypeError(`Invalid host tool definition: ${tool.name}`);
        }
        assertJson(tool.inputSchema);
        assertJson(tool.outputSchema);
        // Detach declarations from caller mutation so model and runtime see the same schema.
        const inputSchema = JSON.parse(JSON.stringify(tool.inputSchema));
        const outputSchema = JSON.parse(JSON.stringify(tool.outputSchema));
        const input = ajv.compile(inputSchema);
        const output = ajv.compile(outputSchema);
        const execute = tool.execute.bind(tool);
        return {
            name: tool.name,
            description: tool.description,
            inputSchema,
            outputSchema,
            execute: async (args, context) => {
                context.signal.throwIfAborted();
                validate(input, args, 'arguments', ajv);
                const result = await execute(args, context);
                context.signal.throwIfAborted();
                validate(output, result, 'result', ajv);
                renderToolResult(result);
                return result;
            },
        };
    });
}
/** Retired ambiguous options must fail explicitly for JavaScript callers as well. */
export function assertToolOptions(options) {
    for (const field of ['allowedTools', 'disallowedTools']) {
        if (field in options) {
            throw new TypeError(`${field} is a Claude-specific query option; use tools to choose business definitions and configure the selected Harness directly`);
        }
    }
    for (const legacy of ['nativeTools', 'hostTools', 'builtinTools', 'mcpServers']) {
        if (legacy in options) {
            throw new TypeError(`${legacy} is no longer a query option; use tools for business definitions and configure the Harness separately`);
        }
    }
    if ('tools' in options && options.tools !== undefined) {
        if (!Array.isArray(options.tools) ||
            options.tools.some((tool) => !tool || typeof tool !== 'object')) {
            throw new TypeError('tools must contain ToolDefinition objects; pass the business definitions required for this query');
        }
    }
}
