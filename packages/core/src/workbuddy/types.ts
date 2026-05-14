/**
 * WorkBuddy type definitions for A2A (Agent-to-Agent) communication.
 *
 * WorkBuddy is a lightweight agent running on the user's local machine,
 * controlled remotely by disclaude via HTTP-based A2A messaging.
 *
 * @see Issue #3442
 * @module @disclaude/core/workbuddy
 */

/**
 * WorkBuddy connection status.
 */
export type WorkBuddyStatus = 'online' | 'offline' | 'error' | 'unknown';

/**
 * A2A command types that disclaude can send to a WorkBuddy.
 */
export type A2ACommandType =
  | 'execute'       // Execute a shell command or task
  | 'health'        // Health check ping
  | 'preview'       // WeChat DevTools: generate preview QR code
  | 'upload'        // WeChat DevTools: upload to WeChat backend
  | 'open'          // WeChat DevTools: open project with debug mode
  | 'close'         // WeChat DevTools: close project
  | 'build-npm';    // WeChat DevTools: build npm dependencies

/**
 * A2A command sent from disclaude to WorkBuddy.
 */
export interface A2ACommand {
  /** Unique command ID */
  id: string;
  /** Command type */
  type: A2ACommandType;
  /** Command payload (instruction text, shell command, etc.) */
  payload: string;
  /** Project key this command targets */
  projectKey: string;
  /** Timestamp when command was created */
  createdAt: string;
  /** Optional timeout override in milliseconds */
  timeoutMs?: number;
}

/**
 * A2A response from WorkBuddy back to disclaude.
 */
export interface A2AResponse {
  /** ID of the command this response corresponds to */
  commandId: string;
  /** Whether the command succeeded */
  success: boolean;
  /** Response payload (output text, base64 image, etc.) */
  payload?: string;
  /** Error message if success is false */
  error?: string;
  /** Timestamp when response was created */
  completedAt: string;
  /** Response content type (text, image, etc.) */
  contentType?: 'text' | 'image' | 'json';
}

/**
 * WorkBuddy health check result.
 */
export interface WorkBuddyHealth {
  /** WorkBuddy project key */
  projectKey: string;
  /** Current status */
  status: WorkBuddyStatus;
  /** Last health check timestamp */
  lastCheckedAt: string;
  /** WorkBuddy process uptime in seconds (if online) */
  uptimeSeconds?: number;
  /** Active tasks being processed */
  activeTasks?: number;
  /** Version string */
  version?: string;
}

/**
 * WorkBuddy manager callbacks.
 * Follows the same pattern as SchedulerCallbacks.
 */
export interface WorkBuddyCallbacks {
  /** Send a text message to a chat */
  sendMessage: (chatId: string, message: string) => Promise<void>;
}
