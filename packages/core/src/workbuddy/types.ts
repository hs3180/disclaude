/**
 * WorkBuddy type definitions.
 *
 * WorkBuddy is a lightweight Agent instance running on the user's local machine.
 * disclaude (server) communicates with WorkBuddy via HTTP to execute local
 * operations like building, previewing, and publishing WeChat mini programs.
 *
 * Phase 1 (Issue #3442): Configuration, HTTP client, basic command routing.
 * @module core/workbuddy/types
 */

/**
 * Status of a WorkBuddy instance.
 */
export type WorkBuddyStatus = 'online' | 'offline' | 'unknown';

/**
 * A single WorkBuddy project configuration from disclaude.config.yaml.
 *
 * Each project represents a WorkBuddy instance bound to a working directory
 * and optionally a Feishu chat. The instance exposes an HTTP API that
 * disclaude can send commands to.
 *
 * @example
 * ```yaml
 * workbuddy:
 *   projects:
 *     my-miniprogram:
 *       url: "http://192.168.1.100:8765"
 *       cwd: "/Users/dev/my-miniprogram"
 *       chatId: "oc_xxxx"
 *       apiKey: "secret-key"
 *       tools:
 *         - wechat-devtools
 * ```
 */
export interface WorkBuddyProjectConfig {
  /** HTTP URL of the WorkBuddy instance (e.g., "http://192.168.1.100:8765") */
  url: string;
  /** Working directory on the remote machine */
  cwd?: string;
  /** Feishu chat ID to bind this WorkBuddy to */
  chatId?: string;
  /** API key for authenticating requests to WorkBuddy */
  apiKey?: string;
  /** Enabled tool integrations (e.g., "wechat-devtools") */
  tools?: string[];
  /** Custom environment variables passed to WorkBuddy commands */
  env?: Record<string, string>;
}

/**
 * WorkBuddy section in disclaude.config.yaml.
 */
export interface WorkBuddyConfig {
  /** Named project configurations */
  projects: Record<string, WorkBuddyProjectConfig>;
  /** Default timeout in milliseconds for HTTP requests to WorkBuddy (default: 30000) */
  timeout?: number;
}

/**
 * Command sent to a WorkBuddy instance.
 */
export interface WorkBuddyCommand {
  /** Command name (e.g., "preview", "upload", "open", "close", "build-npm") */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Working directory override for this command */
  cwd?: string;
  /** Environment variables for this command */
  env?: Record<string, string>;
}

/**
 * Response from a WorkBuddy command execution.
 */
export interface WorkBuddyResponse {
  /** Whether the command succeeded */
  success: boolean;
  /** stdout output from the command */
  stdout?: string;
  /** stderr output from the command */
  stderr?: string;
  /** Exit code of the command */
  exitCode?: number;
  /** Error message if the request failed */
  error?: string;
  /** Additional data (e.g., QR code image path) */
  data?: Record<string, unknown>;
  /** Execution duration in milliseconds */
  durationMs?: number;
}

/**
 * Health check response from a WorkBuddy instance.
 */
export interface WorkBuddyHealth {
  /** Whether the WorkBuddy instance is healthy */
  healthy: boolean;
  /** WorkBuddy version string */
  version?: string;
  /** Configured working directory */
  cwd?: string;
  /** Available tools */
  tools?: string[];
  /** Uptime in seconds */
  uptime?: number;
}

/**
 * Resolved WorkBuddy instance with runtime state.
 */
export interface WorkBuddyInstance {
  /** Project name from config */
  name: string;
  /** HTTP URL */
  url: string;
  /** Bound chat ID (if any) */
  chatId?: string;
  /** Last known status */
  status: WorkBuddyStatus;
  /** Last health check time (ISO string) */
  lastChecked?: string;
  /** Configured tools */
  tools: string[];
}

/**
 * Options for WorkBuddyManager.
 */
export interface WorkBuddyManagerOptions {
  /** Logger instance */
  logger?: import('pino').Logger;
}
