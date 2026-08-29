/**
 * Codex CLI Agent Provider — Skeleton (Issue #4629 / parent #4627)
 *
 * Implements the IAgentSDKProvider contract with real lifecycle methods
 * (name / version / getInfo / validateConfig / dispose) and STUBBED
 * agent-loop / tool / MCP methods. The stubs throw clear errors pointing
 * to the follow-up sub-issue (#4630, S2 of #4627) so callers get an
 * actionable message, not a silent no-op — same precedent as the pi
 * skeleton in #4390.
 *
 * validateConfig() fail-fast environment checks (the S1 deliverable):
 * 1. Binary: a `codex` executable must be resolvable on PATH.
 * 2. Auth:   OAuth must be completed (`codex login` writes auth.json under
 *            CODEX_HOME, default ~/.codex). disclaude never touches
 *            credentials itself — it only checks presence.
 *
 * NOTE on "probe codex --version": validateConfig() is a *synchronous*
 * boolean contract, so spawning the CLI here would block the event loop at
 * boot. The PATH scan gives the same fail-fast signal without a subprocess;
 * actually executing the binary (and mapping its failures) belongs to the
 * S2 spawn bridge (#4630) where the subprocess already exists.
 */

import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

import type { IAgentSDKProvider } from '../../interface.js';
import type {
  AgentQueryOptions,
  InlineToolDefinition,
  McpServerConfig,
  ProviderInfo,
  StreamQueryResult,
  UserInput,
} from '../../types.js';

/**
 * The not-implemented message for the queryStream stub, pointing to the
 * follow-up issue so callers know exactly where the work is tracked.
 */
const NOT_IMPLEMENTED =
  'CodexAgentProvider: this method is not implemented yet — codex exec bridge tracked in #4630 (S2 of #4627).';

/**
 * Tools / MCP are an open question on the parent issue (#4627): Codex has
 * its own MCP config surface, so mapping disclaude's createInlineTool /
 * createMcpServer onto it is deferred rather than stubbed half-way.
 */
const NOT_SUPPORTED =
  'CodexAgentProvider: tools/MCP mapping is not supported yet — tracked as an open question on #4627.';

/**
 * Constructor options — dependency injection seams for tests.
 *
 * `env` controls PATH (binary lookup) and CODEX_HOME (auth lookup). Tests
 * inject a fake env pointing at temp fixtures instead of mocking fs.
 */
export interface CodexAgentProviderOptions {
  /** Environment used for resolution. Default: process.env. */
  env?: Record<string, string | undefined>;
}

/** The file Codex CLI writes after a successful `codex login` (OAuth). */
const AUTH_FILE = 'auth.json';

/**
 * Codex CLI Agent Provider (skeleton)
 *
 * Parent issue: #4627 (agentBackend 'codex' — Codex CLI provider)
 * This issue:   #4629 (S1: skeleton + config & validation)
 */
export class CodexAgentProvider implements IAgentSDKProvider {
  readonly name = 'codex';
  readonly version = '0.0.0-skeleton';

  private readonly env: Record<string, string | undefined>;

  private disposed = false;

  constructor(options: CodexAgentProviderOptions = {}) {
    this.env = options.env ?? process.env;
  }

  // --------------------------------------------------------------------------
  // Provider information
  // --------------------------------------------------------------------------

  getInfo(): ProviderInfo {
    if (this.disposed) {
      return {
        name: this.name,
        version: this.version,
        available: false,
        unavailableReason: 'Provider has been disposed',
      };
    }

    const problems: string[] = [];
    if (!this.findCodexBinary()) {
      problems.push(
        'codex CLI binary not found on PATH — install it first: `npm install -g @openai/codex` (https://developers.openai.com/codex/cli)',
      );
    }
    if (!this.hasAuth()) {
      problems.push(
        'Codex auth missing (OAuth not completed) — run `codex login` (Sign in with ChatGPT); set CODEX_HOME if it is installed elsewhere',
      );
    }

    const info: ProviderInfo = {
      name: this.name,
      version: this.version,
      available: problems.length === 0,
    };
    if (problems.length > 0) {
      info.unavailableReason = problems.join('; ');
    }
    return info;
  }

  // --------------------------------------------------------------------------
  // Query / tool / MCP — stubbed (S2 #4630; tools/MCP open on #4627)
  // --------------------------------------------------------------------------

  queryStream(
    _input: AsyncGenerator<UserInput>,
    _options: AgentQueryOptions,
  ): StreamQueryResult {
    throw new Error(NOT_IMPLEMENTED);
  }

  createInlineTool(_definition: InlineToolDefinition): unknown {
    throw new Error(NOT_SUPPORTED);
  }

  createMcpServer(_config: McpServerConfig): unknown {
    // Codex has its own MCP config surface (~/.codex/config.toml). Whether
    // disclaude maps McpServerConfig onto it or documents codex-native
    // config instead is an open question on #4627 — deliberately not
    // stubbed half-way (same precedent as early pi in #4386 S4).
    throw new Error(NOT_SUPPORTED);
  }

  // --------------------------------------------------------------------------
  // Environment checks (S1 fail-fast) + lifecycle
  // --------------------------------------------------------------------------

  /**
   * Check whether the codex CLI binary is on PATH and auth is present.
   *
   * Returns `false` (never throws) when the environment is not set up —
   * matching ClaudeSDKProvider / PiAgentProvider's pattern. Actionable
   * detail lives in getInfo().unavailableReason.
   */
  validateConfig(): boolean {
    if (this.disposed) {
      return false;
    }
    return this.findCodexBinary() !== undefined && this.hasAuth();
  }

  dispose(): void {
    this.disposed = true;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * Resolve `codex` on PATH (first executable wins).
   *
   * Sync fs scan instead of `codex --version` — see the file header NOTE.
   */
  private findCodexBinary(): string | undefined {
    const pathValue = this.env.PATH ?? '';
    for (const dir of pathValue.split(delimiter)) {
      if (!dir) {
        continue;
      }
      const candidate = join(dir, this.binaryName());
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  /** Windows needs the .cmd shim; everywhere else the bare name. */
  private binaryName(): string {
    return process.platform === 'win32' ? 'codex.cmd' : 'codex';
  }

  /**
   * Codex home directory: CODEX_HOME if set, else ~/.codex — mirroring the
   * CLI's own resolution so the check agrees with what codex exec (S2)
   * will actually read.
   */
  private codexHome(): string {
    return this.env.CODEX_HOME || join(homedir(), '.codex');
  }

  /** OAuth completed ⇔ auth.json exists under the codex home. */
  private hasAuth(): boolean {
    return existsSync(join(this.codexHome(), AUTH_FILE));
  }
}

/** True when `p` exists and is executable (access throws otherwise). */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
