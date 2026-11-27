import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DisclaudeConfig } from '../config/types.js';

/**
 * Shared minimal offline example config for tests (single source, #5760).
 *
 * Unit tests that drive the real service / provider chain offline all need the
 * same minimal config: a `workspace.dir`, one `agents.claude` preset bound to
 * the `default` llm, and one `llms.default` on the anthropic protocol whose key
 * is read from `TEST_LLM_DEFAULT_KEY` at load time. Keep that shape here so a
 * schema evolution (a new llm field, harness-keyed agents, ...) is a one-place
 * change instead of N verbatim copies with drifting placeholder labels.
 */

/** The single `defaultModel` placeholder label shared by every offline fixture config. */
export const OFFLINE_DEFAULT_MODEL = 'offline-fixture';

/** Environment variable the fixture llm reads its API key from. */
export const OFFLINE_LLM_KEY_ENV = 'TEST_LLM_DEFAULT_KEY';

/** Nested-partial overrides: pass only the fields that differ from the defaults. */
export type OfflineConfigOverrides = DeepPartial<DisclaudeConfig>;

type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively merges plain objects; arrays and any other value are replaced. */
function merge(base: Plain, patch: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlain(value) && isPlain(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

/**
 * Builds the minimal offline config for `workspaceDir`.
 * `overrides` is deep-merged over the defaults, so additional `llms` / `agents`
 * entries can be declared next to the built-in ones (multi-llm, multi-backend).
 */
export function makeOfflineConfig(workspaceDir: string, overrides: OfflineConfigOverrides = {}): DisclaudeConfig {
  const base: DisclaudeConfig = {
    workspace: { dir: workspaceDir },
    agents: { claude: { llm: 'default' } },
    llms: { default: { defaultModel: OFFLINE_DEFAULT_MODEL, api: { protocol: 'anthropic', apiKey: `$${OFFLINE_LLM_KEY_ENV}` } } },
  };
  return merge(base as unknown as Plain, overrides as Plain) as unknown as DisclaudeConfig;
}

/** Writes `makeOfflineConfig(dir, overrides)` to `<dir>/config.json` and returns that path. */
export function writeOfflineConfig(dir: string, overrides: OfflineConfigOverrides = {}): string {
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify(makeOfflineConfig(dir, overrides)));
  return configPath;
}
