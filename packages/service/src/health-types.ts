/** Health data for Disclaude's own process and channel delivery paths. */

export type DeliveryErrorType = 'delivery_error' | 'http_4xx';

export interface DeliveryHealth {
  status: 'healthy' | 'degraded' | 'unknown';
  attempts: number;
  successes: number;
  failures: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastErrorType?: DeliveryErrorType;
}
