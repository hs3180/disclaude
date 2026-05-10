/**
 * WeChat DevTools CLI type definitions.
 *
 * Defines types for the WeChat DevTools CLI integration,
 * enabling remote control of mini program build, preview, and upload
 * operations through WorkBuddy.
 *
 * @module wechat-devtools/types
 * @see Issue #3442 - WorkBuddy remote control for WeChat mini programs
 */

// ---------------------------------------------------------------------------
// CLI path discovery
// ---------------------------------------------------------------------------

/**
 * Platform-specific default search paths for the WeChat DevTools CLI.
 */
export const WECHAT_DEVTOOLS_DEFAULT_PATHS = {
  darwin: [
    '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    `${process.env.HOME}/Applications/wechatwebdevtools.app/Contents/MacOS/cli`,
  ],
  win32: [
    'C:/Program Files (x86)/Tencent/微信web开发者工具/cli.bat',
    `${process.env.LOCALAPPDATA}/微信web开发者工具/cli.bat`,
  ],
  linux: [
    '/usr/local/bin/wechat-devtools-cli',
    '/opt/wechat-web-devtools/cli',
  ],
} as const;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a single WeChat mini program project managed by WorkBuddy.
 */
export interface WeChatProjectConfig {
  /** Project working directory (mini program root) */
  cwd: string;
  /** Feishu chat ID bound to this project */
  chatId?: string;
  /** Enabled tool integrations */
  tools?: ('wechat-devtools')[];
  /** Environment variables for the project */
  env?: Record<string, string>;
}

/**
 * WeChat DevTools CLI configuration.
 */
export interface WeChatDevToolsConfig {
  /** Explicit path to the WeChat DevTools CLI binary */
  cliPath?: string;
  /** Project working directory (mini program root) */
  projectPath?: string;
  /** Whether to auto-open the project after starting */
  autoOpen?: boolean;
  /** HTTP port for DevTools service (default: auto-detect) */
  port?: number;
}

/**
 * WorkBuddy configuration section in disclaude.config.yaml.
 */
export interface WorkBuddyConfig {
  /** Registered projects */
  projects?: Record<string, WeChatProjectConfig>;
  /** WeChat DevTools CLI configuration */
  devtools?: WeChatDevToolsConfig;
}

// ---------------------------------------------------------------------------
// Command types
// ---------------------------------------------------------------------------

/**
 * Supported WeChat DevTools CLI commands.
 */
export type WeChatDevToolsCommand =
  | 'preview'
  | 'upload'
  | 'open'
  | 'close'
  | 'build-npm'
  | 'cache'
  | 'auto';

/**
 * Options for the `preview` command.
 */
export interface PreviewOptions {
  /** Project path (defaults to config projectPath) */
  projectPath?: string;
  /** Output format: 'image' for QR code image path */
  format?: 'image';
  /** QR code output path (for format='image') */
  qrOutput?: string;
  /** Compile condition for specific page/path testing */
  compileCondition?: string;
  /** Additional CLI arguments */
  extraArgs?: string[];
}

/**
 * Options for the `upload` command.
 */
export interface UploadOptions {
  /** Project path */
  projectPath?: string;
  /** Version number (e.g., "1.0.0") */
  version?: string;
  /** Upload description/remark */
  desc?: string;
  /** Additional CLI arguments */
  extraArgs?: string[];
}

/**
 * Options for the `open` command.
 */
export interface OpenOptions {
  /** Project path */
  projectPath?: string;
  /** Enable debug mode */
  enableDebug?: boolean;
  /** Additional CLI arguments */
  extraArgs?: string[];
}

/**
 * Options for the `close` command.
 */
export interface CloseOptions {
  /** Project path */
  projectPath?: string;
  /** Additional CLI arguments */
  extraArgs?: string[];
}

/**
 * Options for the `build-npm` command.
 */
export interface BuildNpmOptions {
  /** Project path */
  projectPath?: string;
  /** Additional CLI arguments */
  extraArgs?: string[];
}

/**
 * Cache operation type.
 */
export type CacheOperation = 'clean' | 'list';

/**
 * Options for the `cache` command.
 */
export interface CacheOptions {
  /** Cache operation */
  operation: CacheOperation;
  /** Additional CLI arguments */
  extraArgs?: string[];
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * Base result for CLI commands.
 */
export interface CliResult {
  /** Whether the command succeeded */
  success: boolean;
  /** stdout from the command */
  stdout: string;
  /** stderr from the command */
  stderr: string;
  /** Exit code */
  exitCode: number | null;
  /** Error message if command failed */
  error?: string;
}

/**
 * Result from the `preview` command.
 */
export interface PreviewResult extends CliResult {
  /** Path to the generated QR code image (if format='image') */
  qrImagePath?: string;
}

/**
 * Result from the `upload` command.
 */
export interface UploadResult extends CliResult {
  /** Version that was uploaded */
  version?: string;
}

/**
 * Result from the `open` command.
 */
export interface OpenResult extends CliResult {
  /** Whether debug mode was enabled */
  debugEnabled?: boolean;
}

/**
 * Result from the `cache` command.
 */
export interface CacheResult extends CliResult {
  /** Cache entries (for 'list' operation) */
  entries?: string[];
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Error thrown when the WeChat DevTools CLI cannot be found.
 */
export class WeChatDevToolsNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeChatDevToolsNotFoundError';
  }
}

/**
 * Error thrown when a CLI command fails.
 */
export class WeChatDevToolsCliError extends Error {
  /** Command that failed */
  readonly command: string;
  /** Exit code */
  readonly exitCode: number | null;
  /** stderr output */
  readonly stderr: string;

  constructor(command: string, exitCode: number | null, stderr: string) {
    super(`WeChat DevTools CLI command failed: ${command}\n${stderr}`);
    this.name = 'WeChatDevToolsCliError';
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}
