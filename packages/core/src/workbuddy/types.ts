/**
 * WorkBuddy type definitions — local Agent process management.
 *
 * WorkBuddy is a project-scoped Agent instance running on the user's local
 * machine. It can execute local toolchain commands (e.g., WeChat DevTools CLI)
 * and communicate with the server-side disclaude instance.
 *
 * Phase 1 (this file): Types, configuration, and process management.
 * Future phases will add A2A messaging integration (Issue #3334) for
 * server-to-local bidirectional communication.
 *
 * @see Issue #3442
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Process Status
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Runtime status of a WorkBuddy process.
 */
export type WorkBuddyStatus =
  | 'starting'   // Process spawned, waiting for ready signal
  | 'ready'      // Process is alive and accepting commands
  | 'busy'       // Currently executing a command
  | 'stopping'   // Graceful shutdown in progress
  | 'stopped'    // Process has exited
  | 'error';     // Process crashed or failed to start

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Configuration Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Per-project WorkBuddy configuration.
 *
 * Each project defines a local working directory, an optional Feishu chatId
 * binding, enabled tool integrations, and extra environment variables.
 */
export interface WorkBuddyProjectConfig {
  /** Absolute path to the project's working directory */
  cwd: string;

  /** Feishu chatId to bind this WorkBuddy to (for message routing) */
  chatId?: string;

  /** Enabled tool integrations (e.g., 'wechat-devtools') */
  tools?: string[];

  /** Extra environment variables for the WorkBuddy process */
  env?: Record<string, string>;

  /**
   * Model override for this WorkBuddy's Agent.
   * Falls back to the global agent config if not set.
   */
  model?: string;

  /**
   * Permission mode override.
   * Falls back to the global agent config if not set.
   */
  permissionMode?: 'default' | 'bypassPermissions';
}

/**
 * Top-level WorkBuddy configuration section in disclaude.config.yaml.
 *
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
export interface WorkBuddyConfig {
  /** Named project configurations */
  projects: Record<string, WorkBuddyProjectConfig>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Runtime Instance
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Runtime state of a WorkBuddy process instance.
 *
 * Created by WorkBuddyManager when a project is started.
 */
export interface WorkBuddyInstance {
  /** Project name (key from config) */
  projectName: string;

  /** Current process status */
  status: WorkBuddyStatus;

  /** OS process ID */
  pid?: number;

  /** ISO 8601 timestamp when the process was started */
  startedAt?: string;

  /** ISO 8601 timestamp of the last heartbeat */
  lastHeartbeatAt?: string;

  /** Last error message (if status is 'error') */
  lastError?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Command Protocol
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * WorkBuddy command types.
 *
 * Defines the instructions that can be sent to a WorkBuddy process.
 * Phase 1 uses these types for the protocol definition; actual transport
 * will be implemented when A2A messaging lands (Issue #3334).
 */
export type WorkBuddyCommandType =
  | 'ping'               // Health check
  | 'execute'            // Execute a shell command
  | 'preview'            // WeChat Mini Program preview
  | 'upload'             // WeChat Mini Program upload
  | 'open-debug'         // Open WeChat DevTools in debug mode
  | 'close'              // Close WeChat DevTools
  | 'build-npm'          // Build npm for WeChat project
  | 'custom';            // Custom command

/**
 * A command sent to a WorkBuddy process.
 */
export interface WorkBuddyCommand {
  /** Command type */
  type: WorkBuddyCommandType;

  /** Unique command ID for correlating responses */
  id: string;

  /** Command payload */
  payload?: Record<string, unknown>;
}

/**
 * Response from a WorkBuddy command execution.
 */
export interface WorkBuddyCommandResponse {
  /** ID of the command this responds to */
  commandId: string;

  /** Whether the command succeeded */
  success: boolean;

  /** Result data (e.g., QR code image path for preview) */
  data?: Record<string, unknown>;

  /** Error message if failed */
  error?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Manager Callbacks
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Callbacks for WorkBuddyManager to report events back to the application.
 */
export interface WorkBuddyCallbacks {
  /** Called when a WorkBuddy process status changes */
  onStatusChange: (projectName: string, status: WorkBuddyStatus) => void;

  /** Called when a WorkBuddy sends a command response */
  onResponse: (projectName: string, response: WorkBuddyCommandResponse) => void;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Manager Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a WorkBuddyManager.
 */
export interface WorkBuddyManagerOptions {
  /** WorkBuddy configuration from disclaude.config.yaml */
  config: WorkBuddyConfig;

  /** Optional callbacks for status and response events */
  callbacks?: WorkBuddyCallbacks;

  /** Health check interval in milliseconds (default: 30000) */
  healthCheckIntervalMs?: number;

  /** Graceful shutdown timeout in milliseconds (default: 5000) */
  shutdownTimeoutMs?: number;
}
