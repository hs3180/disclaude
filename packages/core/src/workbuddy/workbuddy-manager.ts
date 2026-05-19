/**
 * WorkBuddy instance manager.
 *
 * Reads WorkBuddy configuration and provides methods to interact with
 * configured instances. Manages instance discovery and status tracking.
 *
 * @module core/workbuddy/workbuddy-manager
 */

import type {
  WorkBuddyConfig,
  WorkBuddyProjectConfig,
  WorkBuddyInstance,
  WorkBuddyCommand,
  WorkBuddyResponse,
  WorkBuddyHealth,
  WorkBuddyManagerOptions,
} from './types.js';
import { WorkBuddyClient } from './workbuddy-client.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('WorkBuddyManager');

/**
 * Manages WorkBuddy instances configured in disclaude.config.yaml.
 *
 * Usage:
 * ```typescript
 * const manager = new WorkBuddyManager(config);
 *
 * // List all configured instances
 * const instances = manager.listInstances();
 *
 * // Get instance by project name
 * const instance = manager.getInstance('my-miniprogram');
 *
 * // Find instance bound to a chatId
 * const instance = manager.findByChatId('oc_xxxx');
 *
 * // Execute a command
 * const response = await manager.execute('my-miniprogram', { command: 'preview' });
 * ```
 */
export class WorkBuddyManager {
  private readonly config: WorkBuddyConfig | undefined;
  private readonly clients: Map<string, WorkBuddyClient> = new Map();
  private readonly statusCache: Map<string, WorkBuddyInstance> = new Map();

  constructor(config: WorkBuddyConfig | undefined, _options?: WorkBuddyManagerOptions) {
    this.config = config;
    if (config?.projects) {
      for (const [name, projectConfig] of Object.entries(config.projects)) {
        this.clients.set(name, new WorkBuddyClient(projectConfig, config.timeout));
        this.statusCache.set(name, {
          name,
          url: projectConfig.url,
          chatId: projectConfig.chatId,
          status: 'unknown',
          tools: projectConfig.tools ?? [],
        });
      }
    }
    logger.info({ count: this.clients.size }, 'WorkBuddyManager initialized');
  }

  /**
   * Check if WorkBuddy is configured.
   */
  isConfigured(): boolean {
    return this.clients.size > 0;
  }

  /**
   * List all configured WorkBuddy instances.
   */
  listInstances(): WorkBuddyInstance[] {
    return Array.from(this.statusCache.values());
  }

  /**
   * Get a WorkBuddy instance by project name.
   */
  getInstance(name: string): WorkBuddyInstance | undefined {
    return this.statusCache.get(name);
  }

  /**
   * Find a WorkBuddy instance bound to a specific chatId.
   */
  findByChatId(chatId: string): WorkBuddyInstance | undefined {
    for (const instance of this.statusCache.values()) {
      if (instance.chatId === chatId) {
        return instance;
      }
    }
    return undefined;
  }

  /**
   * Get the client for a project name.
   */
  getClient(name: string): WorkBuddyClient | undefined {
    return this.clients.get(name);
  }

  /**
   * Get the project config for a project name.
   */
  getProjectConfig(name: string): WorkBuddyProjectConfig | undefined {
    return this.config?.projects?.[name];
  }

  /**
   * Execute a command on a WorkBuddy instance.
   */
  async execute(name: string, command: WorkBuddyCommand): Promise<WorkBuddyResponse> {
    const client = this.clients.get(name);
    if (!client) {
      return {
        success: false,
        error: `WorkBuddy project "${name}" not found. Available: ${[...this.clients.keys()].join(', ')}`,
      };
    }
    return await client.execute(command);
  }

  /**
   * Check health of a specific WorkBuddy instance.
   */
  async healthCheck(name: string): Promise<WorkBuddyHealth> {
    const client = this.clients.get(name);
    if (!client) {
      return { healthy: false };
    }
    const health = await client.healthCheck();
    const instance = this.statusCache.get(name);
    if (instance) {
      instance.status = health.healthy ? 'online' : 'offline';
      instance.lastChecked = new Date().toISOString();
    }
    return health;
  }

  /**
   * Check health of all configured instances.
   */
  async healthCheckAll(): Promise<Record<string, WorkBuddyHealth>> {
    const results: Record<string, WorkBuddyHealth> = {};
    for (const name of this.clients.keys()) {
      results[name] = await this.healthCheck(name);
    }
    return results;
  }
}
