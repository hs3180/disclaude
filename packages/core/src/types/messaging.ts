/**
 * Message level enum for routing decisions.
 *
 * Message levels control which messages are visible to users vs admins:
 * - DEBUG: Debug information → Admin only
 * - PROGRESS: Execution progress → Admin only
 * - INFO: General information → Admin only
 * - NOTICE: Notification → User + Admin
 * - IMPORTANT: Important information → User + Admin (strong alert)
 * - ERROR: Error information → User + Admin
 * - RESULT: Final result → User + Admin
 *
 * @see Issue #266
 */
export enum MessageLevel {
  DEBUG = 'debug',
  PROGRESS = 'progress',
  INFO = 'info',
  NOTICE = 'notice',
  IMPORTANT = 'important',
  ERROR = 'error',
  RESULT = 'result',
}

/**
 * Default message levels visible to users.
 */
export const DEFAULT_USER_LEVELS: MessageLevel[] = [
  MessageLevel.NOTICE,
  MessageLevel.IMPORTANT,
  MessageLevel.ERROR,
  MessageLevel.RESULT,
];

/**
 * All message levels (admin receives all).
 */
export const ALL_LEVELS: MessageLevel[] = [
  MessageLevel.DEBUG,
  MessageLevel.PROGRESS,
  MessageLevel.INFO,
  MessageLevel.NOTICE,
  MessageLevel.IMPORTANT,
  MessageLevel.ERROR,
  MessageLevel.RESULT,
];
