/**
 * Structured lifecycle events shared by channel filters and agent delivery.
 * Issue #4749.
 */
export type LifecycleEventName = 'filter_result' | 'agent_turn' | 'delivery_attempt' | 'delivery_final';
export type DeliveryLedgerState = 'started' | 'tool_progress' | 'final' | 'delivery_failed';

export interface LifecycleContext {
  traceId: string;
  runId: string;
  chatId: string;
  sourceMessageId?: string;
  provider?: string;
}

export interface LifecycleEvent extends LifecycleContext {
  event: LifecycleEventName;
  reason?: import('../config/types.js').FilterReason;
  sanitizedReason?: string;
  target?: string;
  attempt?: number;
  fallback?: string;
  circuitState?: 'closed' | 'open';
  state?: DeliveryLedgerState;
  /** True only after a successful outbound channel send. */
  user_visible?: boolean;
  messageId?: string;
  errorCategory?: string;
  errorCode?: string;
}

export function sanitizeLifecycleReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) {
    return undefined;
  }
  return String(reason).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 240);
}
