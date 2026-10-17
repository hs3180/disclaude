import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** modelOverrides shipped in Claude Code 2.1.200 (Issue #5410). */
const MODEL_OVERRIDES_MIN_VERSION = [2, 1, 200] as const;

let probed = false;
let cached: string | undefined;

/**
 * Claude Code version bundled with the installed agent SDK, when resolvable.
 * The dependency is version-pinned, so this is the CLI disclaude actually
 * spawns. The SDK's exports map hides package.json, so resolve the entry file
 * and read the manifest beside it. Failures return undefined rather than
 * blocking startup.
 */
export function bundledClaudeCodeVersion(): string | undefined {
  if (probed) {
    return cached;
  }
  probed = true;
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
    const manifest = JSON.parse(readFileSync(resolve(dirname(entry), 'package.json'), 'utf8')) as {
      claudeCodeVersion?: unknown;
    };
    cached =
      typeof manifest.claudeCodeVersion === 'string' ? manifest.claudeCodeVersion : undefined;
  } catch {
    cached = undefined;
  }
  return cached;
}

/** True only when the version parsed and is older than the feature's release. */
export function lacksModelOverrides(version: string): boolean {
  const parts = version.split('.').map(Number);
  if (parts.length < 3 || parts.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    return false;
  }
  for (let index = 0; index < MODEL_OVERRIDES_MIN_VERSION.length; index++) {
    const part = parts[index] ?? 0;
    const minimum = MODEL_OVERRIDES_MIN_VERSION[index] ?? 0;
    if (part < minimum) {
      return true;
    }
    if (part > minimum) {
      return false;
    }
  }
  return false;
}
