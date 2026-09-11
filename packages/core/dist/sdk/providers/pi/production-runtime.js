import { adaptPiOptions } from './options-adapter.js';
export function resolvePiModel(options) {
    const env = { ...process.env, ...options.env };
    if (!options.model || !env.ANTHROPIC_API_KEY) {
        throw new Error('PiAgentProvider requires model and ANTHROPIC_API_KEY (see docs/pi-backend.md).');
    }
    const baseUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('PiAgentProvider requires an HTTP(S) ANTHROPIC_BASE_URL.');
    }
    return {
        apiKey: env.ANTHROPIC_API_KEY,
        model: {
            id: options.model,
            name: options.model,
            api: 'anthropic-messages',
            provider: 'anthropic',
            baseUrl,
            reasoning: false,
            input: ['text'],
            // Conservative client budgets, not a claim about a custom model's limits/pricing.
            contextWindow: 32768,
            maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
    };
}
export async function loadPiProduction(options) {
    const { model, apiKey } = resolvePiModel(options);
    // Variable specifiers keep this backend optional for hosts running Claude/Codex/DeepSeek.
    const apiSpecifier = '@earendil-works/pi-ai/api/anthropic-messages';
    const coreSpecifier = '@earendil-works/pi-agent-core';
    const nodeSpecifier = '@earendil-works/pi-agent-core/node';
    const [api, core, node] = await Promise.all([
        import(apiSpecifier),
        import(coreSpecifier),
        import(nodeSpecifier),
    ]);
    const context = {
        env: new node.NodeExecutionEnv({
            cwd: options.cwd,
            shellEnv: { ...process.env, ...options.env },
        }),
    };
    const active = adaptPiOptions(options).activeToolNames;
    const tools = ['Bash', 'Read', 'Write', 'Edit']
        .map((name) => {
        const tool = core[`create${name}Tool`]();
        // Keep disclaude's existing tool-policy names across backends.
        return { ...tool, name, execute: (...args) => tool.execute(...args, context) };
    })
        .filter((tool) => !active || active.includes(tool.name));
    return {
        model,
        tools,
        streamFn: (m, context, streamOptions) => api.streamSimple(m, context, {
            ...streamOptions,
            apiKey,
        }),
    };
}
