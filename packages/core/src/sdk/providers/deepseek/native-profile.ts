import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ApiProtocol } from '../../../config/types.js';
import { DEFAULT_SCHEMA, load, Type } from 'js-yaml';
import { createHash } from 'node:crypto';

export const DSH_API_CREDENTIAL_ENV = 'DISCLAUDE_DSH_API_KEY';

// DSH compositions use !!js scalars; metadata inspection keeps them inert.
const compositionSchema = DEFAULT_SCHEMA.extend([
  new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value) => value }),
]);

export interface DshApiConnection {
  protocol: ApiProtocol;
  baseUrl: string;
  model: string;
}

export function dshApiProvider(api: DshApiConnection): string {
  const identity = createHash('sha256')
    .update(JSON.stringify([api.protocol, api.baseUrl, api.model]))
    .digest('hex')
    .slice(0, 16);
  return `disclaude-api-${identity}`;
}

function existingApiAdapter(files: string[]): string | undefined {
  const ids = new Set<string>();
  const visited = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || visited.has(value)) {
      return;
    }
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.name === 'string' &&
      (entry.name === '@deepseek-ai/dsh-llm-pi-ai' ||
        entry.name.includes('/@deepseek-ai/dsh-llm-pi-ai/'))
    ) {
      if (typeof entry.id !== 'string' || !entry.id.trim()) {
        throw new Error(
          'Give the existing DSH API adapter a profile entry id before using llms.api'
        );
      }
      ids.add(entry.id);
    }
    Object.values(entry).forEach(visit);
  };
  for (const file of files) {
    if (!existsSync(file)) {
      continue;
    }
    let config: unknown;
    try {
      config = load(readFileSync(file, 'utf8'), { schema: compositionSchema });
    } catch {
      throw new Error('Cannot read the selected DSH profile composition');
    }
    visit(config);
  }
  if (ids.size > 1) {
    throw new Error('The selected DSH profile declares multiple API adapters');
  }
  return ids.values().next().value;
}

/** An owned overlay; user profile files stay untouched and only the bound API route is added. */
export function createDshNativeProfileOverlay(
  api?: DshApiConnection,
  profileFiles: string[] = [],
  defaultAdapter?: string
): { path: string; dispose(): void } {
  const plugins: Record<string, unknown>[] = [];
  const patches: Record<string, unknown>[] = [{ id: 'sdk-jsonrpc-server', disabled: true }];
  if (api) {
    const existing = existingApiAdapter(profileFiles) ?? defaultAdapter;
    let adapter: string;
    try {
      adapter = import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai');
    } catch {
      throw new Error(
        'DSH API connections require the optional @deepseek-ai/dsh-llm-pi-ai package'
      );
    }
    const config = {
      providers: {
        [dshApiProvider(api)]: {
          api: api.protocol === 'openai' ? 'openai-completions' : 'anthropic-messages',
          baseURL: api.baseUrl,
          apiKeyEnv: DSH_API_CREDENTIAL_ENV,
          models: [{ id: api.model, name: api.model, input: ['text'] }],
        },
      },
    };
    // Augment an existing adapter once; registering a second one duplicates its directory.
    if (existing) {
      patches.push({ id: existing, disabled: false, config });
    } else {
      plugins.push({ id: 'disclaude-dsh-api', name: adapter, config });
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
