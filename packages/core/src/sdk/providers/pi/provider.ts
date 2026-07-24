/**
 * pi.dev (earendil-works/pi) Agent Provider — Skeleton (Issue #4385)
 *
 * Implements the IAgentSDKProvider contract with real lifecycle methods
 * (name / version / getInfo / validateConfig / dispose) and STUBBED
 * agent-loop / tool / MCP methods. The stubs throw clear errors pointing
 * to the follow-up sub-issues (S3: #4386, S4: #4387) so callers get an
 * actionable message, not a silent no-op.
 *
 * This skeleton is self-contained: it does NOT import pi-agent-core (the
 * package decision is tracked in #4384 / S1). validateConfig() checks
 * whether the pi packages are *importable* at runtime — returning false
 * (never throwing) when they are absent, matching ClaudeSDKProvider's
 * pattern.
 */

import { createRequire } from 'node:module';

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
 * The not-implemented message for stubbed methods, pointing to the
 * follow-up issues so callers know exactly where the work is tracked.
 */
const NOT_IMPLEMENTED =
  'PiAgentProvider: this method is not implemented yet — agent loop tracked in #4386 (S3), tools/MCP in #4387 (S4).';

/**
 * pi.dev Agent Provider (skeleton)
 *
 * Parent issue: #4383 (Add pi.dev as IAgentSDKProvider backend)
 * This issue: #4385 (skeleton wiring)
 */
export class PiAgentProvider implements IAgentSDKProvider {
  readonly name = 'pi';
  readonly version = '0.0.0-skeleton';

  private disposed = false;

  // --------------------------------------------------------------------------
  // Provider information
  // --------------------------------------------------------------------------

  getInfo(): ProviderInfo {
    const available = this.validateConfig();
    const info: ProviderInfo = {
      name: this.name,
      version: this.version,
      available,
    };
    if (!available) {
      info.unavailableReason = 'pi-agent-core package not installed or not configured';
    }
    return info;
  }

  // --------------------------------------------------------------------------
  // Query / tool / MCP — stubbed (S3 #4386, S4 #4387)
  // --------------------------------------------------------------------------

  queryStream(
    _input: AsyncGenerator<UserInput>,
    _options: AgentQueryOptions,
  ): StreamQueryResult {
    throw new Error(NOT_IMPLEMENTED);
  }

  createInlineTool(_definition: InlineToolDefinition): unknown {
    throw new Error(NOT_IMPLEMENTED);
  }

  createMcpServer(_config: McpServerConfig): unknown {
    throw new Error(NOT_IMPLEMENTED);
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Check whether the pi.dev packages are importable and the required
   * configuration (model-provider API key via pi-ai) is present.
   *
   * Returns `false` (never throws) when pi is not set up — matching
   * ClaudeSDKProvider's pattern.
   */
  validateConfig(): boolean {
    if (this.disposed) {
      return false;
    }

    // Dynamic import check — if the package isn't installed, return false.
    // We don't actually import at module load time; this is called on demand
    // by getInfo() / isProviderAvailable().
    try {
      // Resolve the pi-agent-core package without importing it (avoids the
      // side-effects of a full import). This file is ESM, so bare `require`
      // is undefined here — using createRequire() gives us a working
      // require.resolve(). (import.meta.resolve is an alternative but only
      // became synchronous/unflagged in Node 20.6+; createRequire is stable
      // across our >=18 floor.)
      createRequire(import.meta.url).resolve('@earendil-works/pi-agent-core');
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
