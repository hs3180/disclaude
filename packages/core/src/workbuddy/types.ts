/**
 * WorkBuddy type definitions.
 *
 * WorkBuddy is a lightweight Agent process running on the user's local machine,
 * allowing disclaude (server) to execute local operations remotely.
 *
 * Phase 1 (Issue #3442): Basic framework — config, registry, health check, command routing.
 *
 * @see Issue #3442
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Result Type
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Unified result type for WorkBuddy operations.
 */
export type WorkBuddyResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Configuration Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Configuration for a single WorkBuddy project.
 *
 * Defined in `disclaude.config.yaml` under `workbuddy.projects.<name>`.
 */
export interface WorkBuddyProjectConfig {
  /** Working directory on the local machine (project root) */
  cwd: string;
  /** Bound Feishu chat ID for message routing */
  chatId?: string;
  /** HTTP endpoint of the WorkBuddy process (e.g., http://192.168.1.100:8765) */
  endpoint: string;
  /** Enabled tool integrations (e.g., 'wechat-devtools') */
  tools?: string[];
  /** Environment variables passed to the WorkBuddy process */
  env?: Record<string, string>;
}

/**
 * Top-level WorkBuddy configuration section.
 *
 * ```yaml
 * workbuddy:
 *   projects:
 *     my-miniprogram:
 *       cwd: /Users/dev/my-miniprogram
 *       chatId: oc_xxxx
 *       endpoint: http://192.168.1.100:8765
 *       tools:
 *         - wechat-devtools
 * ```
 */
export interface WorkBuddyConfig {
  /** Named WorkBuddy project configurations */
  projects: Record<string, WorkBuddyProjectConfig>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Runtime Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Connection status of a WorkBuddy instance.
 */
export type WorkBuddyStatus = 'connected' | 'disconnected' | 'unknown';

/**
 * Runtime state of a registered WorkBuddy.
 */
export interface WorkBuddyInstance {
  /** Project name (config key) */
  name: string;
  /** Configuration */
  config: WorkBuddyProjectConfig;
  /** Current connection status */
  status: WorkBuddyStatus;
  /** Last health check timestamp (ISO 8601) */
  lastHealthCheck?: string;
  /** Last error message (if any) */
  lastError?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Command Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Command sent to a WorkBuddy for execution.
 */
export interface WorkBuddyCommand {
  /** Command name (e.g., 'preview', 'upload', 'open') */
  command: string;
  /** Command arguments */
  args?: Record<string, unknown>;
  /** Request ID for correlation */
  requestId: string;
}

/**
 * Result returned from a WorkBuddy command execution.
 */
export interface WorkBuddyCommandResult {
  /** Whether the command succeeded */
  success: boolean;
  /** Result data (e.g., QR code image path, upload version) */
  data?: unknown;
  /** Error message on failure */
  error?: string;
  /** Execution duration in milliseconds */
  durationMs?: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constructor Options
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for constructing a WorkBuddyManager.
 */
export interface WorkBuddyManagerOptions {
  /** WorkBuddy configuration (from disclaude.config.yaml) */
  config?: WorkBuddyConfig;
}
