/**
 * Harness runtime catalog for `disclaude harness` (Issue #5169).
 *
 * Single source of truth for which agent harness runtimes the CLI can install
 * and check, which npm packages provide them, and where each must be
 * discoverable after installation (PATH binaries vs production Node module
 * resolution). Default versions always carry the place they are pinned so
 * operators can trace them; every default is overridable via --version or
 * environment.
 */
/** Minimal pi runtime Node requirement from docs/pi-backend.md. */
export const PI_MIN_NODE = [22, 19, 0];
/** Runtime packages for the pi harness; one version applies to both. */
export const PI_RUNTIME_PACKAGES = [
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
];
/** Agent SDK whose bundled Claude Code CLI the service actually spawns. */
export const CLAUDE_AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
/** The npm package a harness installs; claude additionally matches the bundled CLI version. */
const CATALOG = {
    claude: {
        id: 'claude',
        label: 'Claude (Claude Code CLI)',
        installTarget: 'path-cli',
        packages: ['@anthropic-ai/claude-code'],
        binaries: ['claude'],
        versionSource: `pinned ${CLAUDE_AGENT_SDK_PACKAGE} manifest (claudeCodeVersion) — the service runtime this disclaude bundles`,
        docs: 'docs/agent-configuration.md',
        auth: {
            independent: true,
            nextStep: 'The service authenticates through the configured llm apiKey reference; this CLI never reads or writes it. ' +
                'The standalone `claude` binary needs its own one-time `claude login` or ANTHROPIC_API_KEY, set by you.',
        },
    },
    pi: {
        id: 'pi',
        label: 'Pi (earendil-works agent runtime)',
        installTarget: 'node-modules',
        packages: [...PI_RUNTIME_PACKAGES],
        binaries: [],
        pinnedVersion: '0.83.0',
        versionSource: 'docs/pi-backend.md (validated production pin)',
        docs: 'docs/pi-backend.md',
        auth: {
            independent: false,
            nextStep: 'Bind an llm with model and api (protocol/baseUrl/apiKey: $VAR) in disclaude.config.yaml; credentials stay in the service environment. See docs/pi-backend.md.',
        },
    },
    codex: {
        id: 'codex',
        label: 'Codex (OpenAI Codex CLI)',
        installTarget: 'path-cli',
        packages: ['@openai/codex'],
        binaries: ['codex'],
        pinnedVersion: '0.154.0',
        versionSource: 'Dockerfile.service ARG CODEX_VERSION (image build pin)',
        docs: 'docs/codex-backend.md',
        auth: {
            independent: true,
            nextStep: 'Run `codex login` once (ChatGPT OAuth; the session stays under ~/.codex or CODEX_HOME). ' +
                'disclaude never reads, writes or copies those credentials.',
        },
    },
    dsh: {
        id: 'dsh',
        label: 'DeepSeek Harness (dsh)',
        installTarget: 'path-cli',
        packages: ['@deepseek-ai/dsh'],
        binaries: ['dsh'],
        pinnedVersion: '0.1.2-rc.1',
        versionSource: 'Dockerfile.service ARG DSH_VERSION (image build pin)',
        docs: 'docs/dsh-backend.md',
        auth: {
            independent: false,
            nextStep: 'Bind an llm with api.protocol/api.baseUrl/apiKey: $VAR (docs/dsh-backend.md); DSH_HOME optionally isolates its native home. No credential files are touched by this CLI.',
        },
    },
};
export const HARNESS_IDS = ['claude', 'pi', 'codex', 'dsh'];
export function harnessCatalog(id) {
    return CATALOG[id];
}
/** Resolve user input (id, case-insensitive) to a harness id. */
export function resolveHarnessId(input) {
    const normalized = input.trim().toLowerCase();
    return HARNESS_IDS.find((id) => id === normalized);
}
/** Environment key that overrides a harness's default version. */
export function harnessVersionEnvKey(id) {
    return `DISCLAUDE_HARNESS_${id.toUpperCase()}_VERSION`;
}
/**
 * Version precedence: --version flag, then DISCLAUDE_HARNESS_<ID>_VERSION, then
 * the repo pin.
 * Claude's pin is the Claude Code version bundled inside the pinned agent SDK
 * (read from the installed manifest); when that manifest is unreadable the npm
 * `latest` dist-tag is used with an explicit source label.
 */
export function resolveHarnessVersion(id, options = {}) {
    const entry = CATALOG[id];
    if (options.flagVersion) {
        return { value: options.flagVersion, source: '--version flag', overridden: 'flag' };
    }
    const envKey = harnessVersionEnvKey(id);
    const envValue = options.env?.[envKey]?.trim();
    if (envValue) {
        return { value: envValue, source: `environment ${envKey}`, overridden: 'env' };
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
    return { value: entry.pinnedVersion, source: entry.versionSource, overridden: false };
}
/** True when a Node version string (e.g. `v22.19.0`) satisfies the pi minimum. */
export function nodeSatisfiesPi(version) {
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
