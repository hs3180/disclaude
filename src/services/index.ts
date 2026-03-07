/**
 * Services module entry point.
 *
 * Provides global access to shared services.
 */

export {
  LarkClientService,
  type LarkClientServiceConfig,
  type BotInfo,
  type FileUploadResult,
  type SendMessageOptions,
} from './lark-client-service.js';

import { LarkClientService, type LarkClientServiceConfig } from './lark-client-service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('Services');

/**
 * Global LarkClientService instance.
 * Initialized once during application startup.
 */
let globalLarkClientService: LarkClientService | null = null;

/**
 * Initialize the global LarkClientService.
 * Should be called once during PrimaryNode startup.
 *
 * @param config - Service configuration
 */
export function initLarkClientService(config: LarkClientServiceConfig): void {
  if (globalLarkClientService) {
    logger.warn('LarkClientService already initialized, reinitializing...');
  }
  globalLarkClientService = new LarkClientService(config);
  logger.info('LarkClientService initialized');
}

/**
 * Get the global LarkClientService instance.
 *
 * @returns The LarkClientService instance
 * @throws Error if service not initialized
 */
export function getLarkClientService(): LarkClientService {
  if (!globalLarkClientService) {
    throw new Error('LarkClientService not initialized. Call initLarkClientService first.');
  }
  return globalLarkClientService;
}

/**
 * Check if LarkClientService is initialized.
 *
 * @returns true if initialized, false otherwise
 */
export function isLarkClientServiceInitialized(): boolean {
  return globalLarkClientService !== null;
}

/**
 * Reset the global LarkClientService (for testing).
 */
export function resetLarkClientService(): void {
  globalLarkClientService = null;
  logger.debug('LarkClientService reset');
}
