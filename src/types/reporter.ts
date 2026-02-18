/**
 * Reporter type definitions.
 *
 * @module types/reporter
 */

/**
 * Context information passed to Reporter for event processing.
 */
export interface ReporterContext {
  /** Task identifier */
  taskId: string;
  /** Current iteration number */
  iteration: number;
  /** Feishu chat ID for user feedback */
  chatId?: string;
}
