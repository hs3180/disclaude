import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_SCHEMA, load, Type } from 'js-yaml';
import { createHash } from 'node:crypto';
export const DSH_API_CREDENTIAL_ENV = 'DISCLAUDE_DSH_API_KEY';
// DSH compositions use !!js scalars; metadata inspection keeps them inert.
const compositionSchema = DEFAULT_SCHEMA.extend([
    new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value) => value }),
]);
export function dshApiProvider(api) {
    const identity = createHash('sha256')
        .update(JSON.stringify([api.protocol, api.baseUrl, api.model]))
        .digest('hex')
        .slice(0, 16);
    return `disclaude-api-${identity}`;
}
function existingPlugin(files, packageName) {
    const label = packageName === '@deepseek-ai/dsh-llm-pi-ai' ? 'API adapter' : `${packageName} plugin`;
    const ids = new Set();
    const visited = new Set();
    const visit = (value) => {
        if (!value || typeof value !== 'object' || visited.has(value)) {
            return;
        }
        visited.add(value);
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        const entry = value;
        if (typeof entry.name === 'string' &&
            (entry.name === packageName || entry.name.includes(`/${packageName}/`))) {
            if (typeof entry.id !== 'string' || !entry.id.trim()) {
                throw new Error(`Give the existing DSH ${label} a profile entry id before applying an overlay`);
            }
            ids.add(entry.id);
        }
        Object.values(entry).forEach(visit);
    };
    for (const file of files) {
        if (!existsSync(file)) {
            continue;
        }
        let config;
        try {
            config = load(readFileSync(file, 'utf8'), { schema: compositionSchema });
        }
        catch {
            throw new Error('Cannot read the selected DSH profile composition');
        }
        visit(config);
    }
    if (ids.size > 1) {
        throw new Error(`The selected DSH profile declares multiple ${label}s`);
    }
    return ids.values().next().value;
}
/** An owned overlay; user profile files stay untouched and only the bound API route is added. */
export function createDshNativeProfileOverlay(api, profileFiles = [], defaultAdapter, compaction) {
    const plugins = [];
    const patches = [{ id: 'sdk-jsonrpc-server', disabled: true }];
    if (api) {
        const existing = existingPlugin(profileFiles, '@deepseek-ai/dsh-llm-pi-ai') ?? defaultAdapter;
        let adapter;
        try {
            adapter = import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai');
        }
        catch {
            throw new Error('DSH API connections require the optional @deepseek-ai/dsh-llm-pi-ai package');
        }
        const config = {
            providers: {
                [dshApiProvider(api)]: {
                    api: api.protocol === 'openai' ? 'openai-completions' : 'anthropic-messages',
                    baseURL: api.baseUrl,
                    apiKeyEnv: DSH_API_CREDENTIAL_ENV,
                    models: [{ id: api.model, name: api.model, input: ['text'],
                            ...(compaction?.contextWindow ? { contextWindow: compaction.contextWindow } : {}) }],
                },
            },
        };
        // Augment an existing adapter once; registering a second one duplicates its directory.
        if (existing) {
            patches.push({ id: existing, disabled: false, config });
        }
        else {
            plugins.push({ id: 'disclaude-dsh-api', name: adapter, config });
        }
    }
    if (compaction) {
        for (const [id, packageName, config] of [
            ['token-meter', '@deepseek-ai/dsh-token-meter', undefined],
            ['compaction-basic', '@deepseek-ai/dsh-compaction-basic', {
                    auto: compaction.auto, thresholdRatio: compaction.thresholdRatio,
                    // Keep a recent tail below even a deliberately small configured trigger.
                    retainRatio: Math.min(0.16, compaction.thresholdRatio / 2),
                }],
        ]) {
            const existing = existingPlugin(profileFiles, packageName) ?? (defaultAdapter ? id : undefined);
            if (existing) {
                patches.push({ id: existing, disabled: false, ...(config ? { config } : {}) });
            }
            else {
                plugins.push({ id: `disclaude-${id}`, name: packageName, ...(config ? { config } : {}) });
            }
        }
    }
    plugins.push({
        id: 'disclaude-dsh-native-app',
        name: new URL('./native-app.js', import.meta.url).href,
    });
    const directory = mkdtempSync(join(tmpdir(), 'disclaude-dsh-native-'));
    const path = join(directory, 'cordis.patch.yml');
    writeFileSync(path, JSON.stringify([...patches, { insert: plugins }]), { mode: 0o600 });
    return { path, dispose: () => rmSync(directory, { recursive: true }) };
}
