/**
 * WorkBuddy type definitions.
 *
 * WorkBuddy is a lightweight Agent instance running in a user's local project
 * directory, enabling remote control of local development tools (e.g., WeChat
 * Developer Tools CLI, npm scripts) through disclaude's A2A messaging system.
 *
 * @module core/workbuddy/types
 * @see Issue #3442
 */

// ---------------------------------------------------------------------------
// Configuration types (loaded from disclaude.config.yaml → workbuddy.projects)
// ---------------------------------------------------------------------------

/**
 * Configuration for a single WorkBuddy project.
 *
 * Each project maps to a WorkBuddy process that runs in the specified `cwd`
 * directory, bound to a Feishu chat for communication.
 *
 * @example
 * ```yaml
 * workbuddy:
 *   projects:
 *     my-miniprogram:
 *       cwd: /Users/dev/my-miniprogram
 *       chatId: oc_xxxx
 *       tools:
 *         - wechat-devtools
 *       env:
 *         WECHAT_DEVTOOLS_PATH: /Applications/wechatwebdevtools.app
 * ```
 */
export interface WorkBuddyProjectConfig {
  /** Working directory — the WorkBuddy agent runs with this as CWD */
  cwd: string;
  /** Feishu chat ID bound to this project (commands from this chat are routed here) */
  chatId: string;
  /** Enabled tool integrations (e.g., 'wechat-devtools') */
  tools?: string[];
  /** Extra environment variables injected into the WorkBuddy process */
  env?: Record<string, string>;
}

/**
 * Top-level WorkBuddy configuration section in disclaude.config.yaml.
 *
 * @example
 * ```yaml
 * workbuddy:
 *   projects:
 *     my-miniprogram:
 *       cwd: /Users/dev/my-miniprogram
 *       chatId: oc_xxxx
 * ```
 */
export interface WorkBuddyConfig {
  /** Named project configurations */
  projects: Record<string, WorkBuddyProjectConfig>;
}

// ---------------------------------------------------------------------------
// Runtime types
// ---------------------------------------------------------------------------

/**
 * Lifecycle status of a WorkBuddy process.
 */
export type WorkBuddyProcessStatus =
  | 'starting'   // Process is being spawned
  | 'running'    // Process is healthy and accepting commands
  | 'stopping'   // Process is shutting down
  | 'stopped'    // Process has exited cleanly
  | 'error';     // Process exited with an error or is unreachable

/**
 * Represents a running WorkBuddy process tracked by the manager.
 */
export interface WorkBuddyProcess {
  /** Project name (key from config) */
  projectName: string;
  /** Current status */
  status: WorkBuddyProcessStatus;
  /** Child process PID (set once spawned) */
  pid?: number;
  /** Absolute CWD of the project */
  cwd: string;
  /** Bound chat ID */
  chatId: string;
  /** Unix socket path for IPC communication */
  socketPath: string;
  /** Timestamp when the process was started */
  startedAt?: string;
  /** Last health-check timestamp */
  lastHealthCheck?: string;
  /** Error message if status is 'error' */
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Communication types (IPC protocol extension)
// ---------------------------------------------------------------------------

/**
 * Command sent from disclaude to a WorkBuddy process.
 */
export interface WorkBuddyCommand {
  /** Command type (e.g., 'execute', 'health', 'preview', 'upload') */
  type: string;
  /** Command payload — varies by command type */
  payload: Record<string, unknown>;
  /** Optional timeout in milliseconds (default: 30_000) */
  timeout?: number;
}

/**
 * Result returned from a WorkBuddy process after executing a command.
 */
export interface WorkBuddyResult {
  /** Whether the command succeeded */
  success: boolean;
  /** Result data (varies by command type) */
  data?: unknown;
  /** Error message if `success` is false */
  error?: string;
}

/**
 * Health check response from a WorkBuddy process.
 */
export interface WorkBuddyHealth {
  /** Whether the process is healthy */
  healthy: boolean;
  /** Project name */
  projectName: string;
  /** Current working directory */
  cwd: string;
  /** Process uptime in seconds */
  uptimeSeconds?: number;
  /** Connected tool integrations */
  tools?: string[];
}

/**
 * Map from chatId to project name, used for routing incoming messages to the
 * correct WorkBuddy instance.
 */
export type WorkBuddyChatRouting = Map<string, string>;
