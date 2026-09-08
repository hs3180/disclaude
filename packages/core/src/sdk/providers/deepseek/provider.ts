/**
 * DeepSeek harness provider contract (Issue #4741).
 *
 * This first slice registers the backend and performs fail-fast environment
 * checks. The dsh stdio transport and event bridge are separate follow-ups
 * (#4742/#4743); no simulated response is emitted here.
 */
import { existsSync } from 'node:fs';
import { createLogger } from '../../../utils/logger.js';
import type { IAgentSDKProvider } from '../../interface.js';
import type {
  AgentQueryOptions,
  InlineToolDefinition,
  McpServerConfig,
  ProviderInfo,
  StreamQueryResult,
  UserInput,
} from '../../types.js';

const logger = createLogger('DeepSeekHarnessProvider');

export interface DeepSeekHarnessProviderOptions {
  env?: Record<string, string | undefined>;
  apiKey?: string;
  dshHome?: string;
}

export class DeepSeekHarnessProvider implements IAgentSDKProvider {
  readonly name = 'deepseek';
  readonly version = '0.0.0-harness-preview';
  private readonly env: Record<string, string | undefined>;
  private readonly apiKey?: string;
  private readonly dshHome?: string;
  private disposed = false;

  constructor(options: DeepSeekHarnessProviderOptions = {}) {
    this.env = options.env ?? process.env;
    this.apiKey = options.apiKey ?? this.env.DEEPSEEK_API_KEY;
    this.dshHome = options.dshHome ?? this.env.DSH_HOME;
  }

  getInfo(): ProviderInfo {
    const available = this.validateConfig();
    return {
      name: this.name,
      version: this.version,
      available,
      ...(available ? {} : { unavailableReason: this.diagnose() }),
    };
  }

  queryStream(_input: AsyncGenerator<UserInput>, _options: AgentQueryOptions): StreamQueryResult {
    throw new Error(
      'DeepSeekHarnessProvider: dsh stdio transport is not enabled yet; implementation is tracked in #4742.'
    );
  }

  createInlineTool(_definition: InlineToolDefinition): unknown {
    throw new Error('DeepSeekHarnessProvider: tool mapping is tracked in #4744.');
  }

  createMcpServer(_config: McpServerConfig): unknown {
    throw new Error('DeepSeekHarnessProvider: MCP mapping is not supported by the preview.');
  }

  validateConfig(): boolean {
    return !this.disposed && Boolean(this.apiKey) && this.hasDshHome();
  }

  dispose(): void {
    this.disposed = true;
  }

  private hasDshHome(): boolean {
    return !this.dshHome || existsSync(this.dshHome);
  }

  private diagnose(): string {
    if (!this.apiKey) {
      return 'missing DEEPSEEK_API_KEY (set deepseek.apiKey or the environment variable)';
    }
    if (this.dshHome && !existsSync(this.dshHome)) {
      return `DSH_HOME does not exist: ${this.dshHome}`;
    }
    logger.debug('DeepSeek harness configuration is valid but transport is preview-only');
    return 'dsh stdio transport is not implemented yet';
  }
}
