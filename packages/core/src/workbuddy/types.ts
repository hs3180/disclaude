/**
 * WorkBuddy type definitions for remote local-agent control.
 *
 * WorkBuddy is a project-scoped agent running on the user's local machine.
 * It connects to the disclaude server, receives commands (e.g., WeChat
 * DevTools CLI operations), executes them locally, and returns results.
 *
 * @see Issue #3442
 */

/**
 * WorkBuddy connection status.
 */
export type WorkBuddyStatus = 'online' | 'offline' | 'busy' | 'error';

/**
 * WorkBuddy command priority.
 */
export type WorkBuddyCommandPriority = 'low' | 'normal' | 'high';

/**
 * Result of a WorkBuddy command execution.
 */
export type WorkBuddyResultStatus = 'success' | 'error' | 'timeout';

/**
 * Configuration for a single WorkBuddy project.
 * Defined in disclaude.config.yaml under `workbuddy.projects`.
 *
 * @example
 * ```yaml
 * workbuddy:
 *   projects:
 *     my-miniprogram:
 *       workingDir: /Users/dev/my-miniprogram
 *       chatId: oc_xxxx
 *       tools:
 *         - wechat-devtools
 *       env:
 *         WECHAT_DEVTOOLS_PATH: /Applications/wechatwebdevtools.app
 * ```
 */
export interface WorkBuddyProjectConfig {
  /** Project working directory on the local machine */
  workingDir: string;
  /** Bound Feishu chat ID for agent output */
  chatId: string;
  /** Enabled tool integrations (e.g., 'wechat-devtools') */
  tools?: string[];
  /** Environment variables for the WorkBuddy process */
  env?: Record<string, string>;
  /** Health check interval in seconds (default: 30) */
  healthCheckIntervalSec?: number;
  /** Command execution timeout in milliseconds (default: 60000) */
  commandTimeoutMs?: number;
}

/**
 * WorkBuddy top-level configuration.
 * Placed under `workbuddy` key in disclaude.config.yaml.
 */
export interface WorkBuddyConfig {
  /** Project configurations keyed by project key */
  projects: Record<string, WorkBuddyProjectConfig>;
}

/**
 * Registration info for a connected WorkBuddy.
 * Tracked by WorkBuddyManager on the server side.
 */
export interface WorkBuddyRegistration {
  /** Project key from config */
  projectKey: string;
  /** Connection status */
  status: WorkBuddyStatus;
  /** Timestamp of initial registration (ISO 8601) */
  registeredAt: string;
  /** Timestamp of last health check (ISO 8601) */
  lastHealthCheck: string;
  /** Timestamp of last command execution (ISO 8601) */
  lastCommandAt?: string;
  /** Active command ID if currently executing */
  activeCommandId?: string;
}

/**
 * A command sent from the server to a WorkBuddy.
 */
export interface WorkBuddyCommand {
  /** Unique command ID */
  id: string;
  /** Command type (e.g., 'preview', 'upload', 'open', 'close') */
  type: string;
  /** Command payload (arguments, options) */
  payload?: Record<string, unknown>;
  /** Command priority */
  priority?: WorkBuddyCommandPriority;
  /** Timestamp when the command was created (ISO 8601) */
  createdAt: string;
  /** Maximum execution time in milliseconds */
  timeoutMs?: number;
}

/**
 * Result returned by a WorkBuddy after executing a command.
 */
export interface WorkBuddyCommandResult {
  /** ID of the command this result is for */
  commandId: string;
  /** Execution status */
  status: WorkBuddyResultStatus;
  /** Text output from the command */
  output?: string;
  /** Error message if status is 'error' or 'timeout' */
  error?: string;
  /** Duration of execution in milliseconds */
  durationMs?: number;
  /** Timestamp when the result was created (ISO 8601) */
  completedAt: string;
  /** Optional artifacts (file paths, image URLs, etc.) */
  artifacts?: WorkBuddyArtifact[];
}

/**
 * An artifact produced by a WorkBuddy command.
 * For example, a preview QR code image.
 */
export interface WorkBuddyArtifact {
  /** Artifact type */
  type: 'image' | 'file' | 'url';
  /** Artifact value (file path, URL, etc.) */
  value: string;
  /** Optional MIME type */
  mimeType?: string;
}
