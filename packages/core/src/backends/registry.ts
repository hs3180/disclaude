/**
 * Backend runtime catalog for `disclaude backend` (Issue #5169).
 *
 * Single source of truth for which agent runtimes the CLI can install and
 * check, which npm packages provide them, and where each must be discoverable
 * after installation (PATH binaries vs production Node module resolution).
 * Default versions always carry the place they are pinned so operators can
 * trace them; every default is overridable via --version or environment.
 */

import type { BackendId, InstallTarget } from './types.js';

/** Minimal pi runtime Node requirement from docs/pi-backend.md. */
export const PI_MIN_NODE = [22, 19, 0] as const;

/** Runtime packages for the pi backend; one version applies to both. */
export const PI_RUNTIME_PACKAGES = [
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
] as const;

/** Agent SDK whose bundled Claude Code CLI the service actually spawns. */
export const CLAUDE_AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

export interface BackendCatalogEntry {
  id: BackendId;
  aliases: string[];
  label: string;
  /** PATH CLI binaries vs Node modules under production resolution. */
  installTarget: InstallTarget;
  /** npm package names providing the runtime. */
  packages: string[];
  /** PATH binary names the service spawns this backend through. */
  binaries: string[];
  /** Repo-pinned default version; claude resolves its pin from the SDK manifest. */
  pinnedVersion?: string;
  /** Where the default version comes from — surfaced in every CLI answer. */
  versionSource: string;
  docs: string;
  /** Independent auth (login/session) the CLI must never touch. */
  auth: { independent: boolean; nextStep: string };
}

/** The npm package a backend installs; claude additionally matches the bundled CLI version. */
const CATALOG: Record<BackendId, BackendCatalogEntry> = {
  claude: {
    id: 'claude',
    aliases: [],
    label: 'Claude (Claude Code CLI)',
    installTarget: 'path-cli',
    packages: ['@anthropic-ai/claude-code'],
    binaries: ['claude'],
    versionSource: `pinned ${CLAUDE_AGENT_SDK_PACKAGE} manifest (claudeCodeVersion) — the service runtime this disclaude bundles`,
    docs: 'docs/agent-configuration.md',
    auth: {
      independent: true,
      nextStep:
        'The service authenticates through the configured llm apiKey reference; this CLI never reads or writes it. ' +
        'The standalone `claude` binary needs its own one-time `claude login` or ANTHROPIC_API_KEY, set by you.',
    },
  },
  pi: {
    id: 'pi',
    aliases: [],
    label: 'Pi (earendil-works agent runtime)',
    installTarget: 'node-modules',
    packages: [...PI_RUNTIME_PACKAGES],
    binaries: [],
    pinnedVersion: '0.83.0',
    versionSource: 'docs/pi-backend.md (validated production pin)',
    docs: 'docs/pi-backend.md',
    auth: {
      independent: false,
      nextStep:
        'Bind an llm with model and api (protocol/baseUrl/apiKey: $VAR) in disclaude.config.yaml; credentials stay in the service environment. See docs/pi-backend.md.',
    },
  },
  codex: {
    id: 'codex',
    aliases: [],
    label: 'Codex (OpenAI Codex CLI)',
    installTarget: 'path-cli',
    packages: ['@openai/codex'],
    binaries: ['codex'],
    pinnedVersion: '0.154.0',
    versionSource: 'Dockerfile.service ARG CODEX_VERSION (image build pin)',
    docs: 'docs/codex-backend.md',
    auth: {
      independent: true,
      nextStep:
        'Run `codex login` once (ChatGPT OAuth; the session stays under ~/.codex or CODEX_HOME). ' +
        'disclaude never reads, writes or copies those credentials.',
    },
  },
  dsh: {
    id: 'dsh',
    aliases: ['deepseek'],
    label: 'DeepSeek Harness (dsh)',
    installTarget: 'path-cli',
    packages: ['@deepseek-ai/dsh'],
    binaries: ['dsh'],
    pinnedVersion: '0.1.2-rc.1',
    versionSource: 'Dockerfile.service ARG DSH_VERSION (image build pin)',
    docs: 'docs/dsh-backend.md',
    auth: {
      independent: false,
      nextStep:
        'Bind an llm with api.protocol/api.baseUrl/apiKey: $VAR (docs/dsh-backend.md); DSH_HOME optionally isolates its native home. No credential files are touched by this CLI.',
    },
  },
};

export const BACKEND_IDS: BackendId[] = ['claude', 'pi', 'codex', 'dsh'];

export function backendCatalog(id: BackendId): BackendCatalogEntry {
  return CATALOG[id];
}

/** Resolve user input (id or alias, case-insensitive) to a backend id. */
export function resolveBackendId(input: string): BackendId | undefined {
  const normalized = input.trim().toLowerCase();
  return BACKEND_IDS.find((id) => id === normalized || CATALOG[id].aliases.includes(normalized));
}

/** Environment key that overrides a backend's default version. */
export function backendVersionEnvKey(id: BackendId): string {
  return `DISCLAUDE_BACKEND_${id.toUpperCase()}_VERSION`;
}

export interface ResolvedVersion {
  value: string;
  source: string;
  overridden: 'flag' | 'env' | false;
}

/**
 * Version precedence: --version flag, then DISCLAUDE_BACKEND_<ID>_VERSION, then
 * the repo pin. Claude's pin is the Claude Code version bundled inside the
 * pinned agent SDK (read from the installed manifest); when that manifest is
 * unreadable the npm `latest` dist-tag is used with an explicit source label.
 */
export function resolveBackendVersion(
  id: BackendId,
  options: {
    flagVersion?: string;
    env?: Record<string, string | undefined>;
    /** claudeCodeVersion probed from the bundled SDK manifest. */
    claudeBundledVersion?: string;
  } = {}
): ResolvedVersion {
  const entry = CATALOG[id];
  if (options.flagVersion) {
    return { value: options.flagVersion, source: '--version flag', overridden: 'flag' };
  }
  const envValue = options.env?.[backendVersionEnvKey(id)]?.trim();
  if (envValue) {
    return {
      value: envValue,
      source: `environment ${backendVersionEnvKey(id)}`,
      overridden: 'env',
    };
  }
  if (id === 'claude') {
    return options.claudeBundledVersion
      ? {
          value: options.claudeBundledVersion,
          source: entry.versionSource,
          overridden: false,
        }
      : {
          value: 'latest',
          source: 'npm dist-tag latest (bundled SDK manifest unavailable)',
          overridden: false,
        };
  }
  return { value: entry.pinnedVersion as string, source: entry.versionSource, overridden: false };
}

/** True when a Node version string (e.g. `v22.19.0`) satisfies the pi minimum. */
export function nodeSatisfiesPi(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) {
    return false;
  }
  const parts = match.slice(1).map(Number);
  const minimum = PI_MIN_NODE;
  for (let index = 0; index < minimum.length; index++) {
    const actual = parts[index] ?? 0;
    if (actual < minimum[index]) {
      return false;
    }
    if (actual > minimum[index]) {
      return true;
    }
  }
  return true;
}
