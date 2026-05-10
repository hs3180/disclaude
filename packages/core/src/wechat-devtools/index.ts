/**
 * WeChat DevTools CLI integration module.
 *
 * Provides CLI path discovery and command wrappers for the WeChat DevTools,
 * enabling automated mini program preview, upload, and debug operations
 * as part of the WorkBuddy system.
 *
 * @module wechat-devtools
 * @see Issue #3442 - WorkBuddy remote control for WeChat mini programs
 */

// Types
export type {
  WeChatProjectConfig,
  WeChatDevToolsConfig,
  WorkBuddyConfig,
  WeChatDevToolsCommand,
  PreviewOptions,
  UploadOptions,
  OpenOptions,
  CloseOptions,
  BuildNpmOptions,
  CacheOptions,
  CacheOperation,
  CliResult,
  PreviewResult,
  UploadResult,
  OpenResult,
  CacheResult,
} from './types.js';

export {
  WECHAT_DEVTOOLS_DEFAULT_PATHS,
  WeChatDevToolsNotFoundError,
  WeChatDevToolsCliError,
} from './types.js';

// CLI wrapper
export {
  discoverCliPath,
  WeChatDevToolsCli,
  isWeChatDevToolsAvailable,
} from './cli.js';
