/**
 * Platform Adapter Factory.
 *
 * Factory for creating platform-specific adapters based on configuration.
 * Supports dynamic registration of new platforms.
 */

import type { Logger } from 'pino';
import type { IPlatformAdapter, IAttachmentManager } from './types.js';
import { FeishuPlatformAdapter, type FeishuPlatformAdapterConfig } from '../../../platforms/feishu/index.js';
import { RestPlatformAdapter, type RestPlatformAdapterConfig } from '../platforms/rest/index.js';

/**
 * Supported platform types.
 */
export type PlatformType = 'feishu' | 'rest' | string;

/**
 * Base configuration for all platform adapters.
 */
export interface BasePlatformConfig {
  /** Platform type identifier */
  type: PlatformType;
  /** Logger instance */
  logger?: Logger;
}

/**
 * Configuration for Feishu platform adapter.
 */
export interface FeishuConfig extends BasePlatformConfig {
  type: 'feishu';
  /** Feishu App ID */
  appId: string;
  /** Feishu App Secret */
  appSecret: string;
  /** Attachment manager for file handling */
  attachmentManager: IAttachmentManager;
  /** File download function */
  downloadFile: FeishuPlatformAdapterConfig['downloadFile'];
}

/**
 * Configuration for REST platform adapter.
 */
export interface RestConfig extends BasePlatformConfig {
  type: 'rest';
  /** Base URL for REST API (optional) */
  baseUrl?: string;
  /** API key for authentication (optional) */
  apiKey?: string;
}

/**
 * Union type of all platform configurations.
 */
export type PlatformConfig = FeishuConfig | RestConfig;

/**
 * Platform adapter factory function type.
 */
export type PlatformAdapterFactoryFn = (config: BasePlatformConfig & Record<string, unknown>) => IPlatformAdapter;

/**
 * Platform Adapter Factory.
 *
 * Creates platform-specific adapters based on configuration.
 * Supports dynamic registration of new platforms.
 *
 * @example
 * ```typescript
 * const factory = new PlatformAdapterFactory(logger);
 *
 * // Create Feishu adapter
 * const feishuAdapter = factory.create({
 *   type: 'feishu',
 *   appId: 'xxx',
 *   appSecret: 'yyy',
 *   attachmentManager,
 *   downloadFile: myDownloadFn,
 * });
 *
 * // Register custom platform
 * factory.register('custom', (config) => new CustomAdapter(config));
 * ```
 */
export class PlatformAdapterFactory {
  private logger: Logger;
  private factories: Map<PlatformType, PlatformAdapterFactoryFn> = new Map();

  constructor(logger: Logger) {
    this.logger = logger;

    // Register built-in platforms
    this.registerBuiltInFactories();
  }

  /**
   * Create a platform adapter based on configuration.
   *
   * @param config - Platform configuration
   * @returns Platform adapter instance
   * @throws Error if platform type is not supported
   */
  create(config: PlatformConfig): IPlatformAdapter {
    const { type } = config;
    const factory = this.factories.get(type);

    if (!factory) {
      const supportedTypes = Array.from(this.factories.keys()).join(', ');
      throw new Error(
        `Unsupported platform type: ${type}. Supported types: ${supportedTypes}`
      );
    }

    this.logger.debug({ type }, 'Creating platform adapter');
    return factory(config);
  }

  /**
   * Register a custom platform adapter factory.
   *
   * @param type - Platform type identifier
   * @param factory - Factory function to create the adapter
   */
  register(type: PlatformType, factory: PlatformAdapterFactoryFn): void {
    if (this.factories.has(type)) {
      this.logger.warn({ type }, 'Overwriting existing platform factory');
    }

    this.factories.set(type, factory);
    this.logger.debug({ type }, 'Platform factory registered');
  }

  /**
   * Check if a platform type is supported.
   *
   * @param type - Platform type identifier
   * @returns Whether the platform is supported
   */
  isSupported(type: PlatformType): boolean {
    return this.factories.has(type);
  }

  /**
   * Get list of supported platform types.
   *
   * @returns Array of supported platform types
   */
  getSupportedTypes(): PlatformType[] {
    return Array.from(this.factories.keys());
  }

  /**
   * Register built-in platform factories.
   */
  private registerBuiltInFactories(): void {
    // Feishu factory
    this.register('feishu', (config) => {
      const feishuConfig = config as FeishuConfig;
      return new FeishuPlatformAdapter({
        appId: feishuConfig.appId,
        appSecret: feishuConfig.appSecret,
        logger: feishuConfig.logger ?? this.logger,
        attachmentManager: feishuConfig.attachmentManager,
        downloadFile: feishuConfig.downloadFile,
      });
    });

    // REST factory
    this.register('rest', (config) => {
      const restConfig = config as RestConfig;
      return new RestPlatformAdapter({
        baseUrl: restConfig.baseUrl,
        apiKey: restConfig.apiKey,
        logger: restConfig.logger ?? this.logger,
      });
    });
  }
}

/**
 * Create a platform adapter factory.
 *
 * @param logger - Logger instance
 * @returns Platform adapter factory instance
 */
export function createPlatformAdapterFactory(logger: Logger): PlatformAdapterFactory {
  return new PlatformAdapterFactory(logger);
}
