import { browserAgentEnv } from '../../../utils/browser-env.js';
export function resolvePiModel(options) {
    const env = options.env ?? process.env;
    const protocol = options.apiProtocol ?? 'anthropic';
    const keyName = protocol === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    const urlName = protocol === 'openai' ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL';
    const apiKey = env[keyName];
    if (!options.model || !apiKey) {
        throw new Error(`PiAgentProvider requires model and ${keyName} (see docs/pi-backend.md).`);
    }
    const baseUrl = env[urlName] ||
        (protocol === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com');
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('PiAgentProvider requires an HTTP(S) API base URL.');
    }
    return {
        apiKey,
        model: {
            id: options.model,
            name: options.model,
            api: protocol === 'openai' ? 'openai-completions' : 'anthropic-messages',
            provider: protocol,
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
    // Variable specifiers keep this backend optional for hosts running Claude/Codex/DSH.
    const apiSpecifier = `@earendil-works/pi-ai/api/${model.api}`;
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
            shellEnv: browserAgentEnv(options.env ?? process.env),
        }),
    };
    const tools = ['Bash', 'Read', 'Write', 'Edit'].map((name) => {
        const tool = core[`create${name}Tool`]();
        // Expose the existing Pi coding tool names.
        return { ...tool, name, execute: (...args) => tool.execute(...args, context) };
    });
    return {
        model,
        tools,
        streamFn: (m, context, streamOptions) => api.streamSimple(m, context, {
            ...streamOptions,
            apiKey,
        }),
    };
}
