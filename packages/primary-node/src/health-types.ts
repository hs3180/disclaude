/** Health data for Disclaude's own process and channel delivery paths. */

export type ProbeErrorType = 'delivery_error';

export interface DeliveryHealth {
  status: 'healthy' | 'degraded' | 'unknown';
  attempts: number;
  successes: number;
  failures: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastErrorType?: ProbeErrorType;
}
