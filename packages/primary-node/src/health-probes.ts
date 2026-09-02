/**
 * Small, dependency-free HTTP probes for operator-facing diagnostics.
 *
 * These probes deliberately do not share the liveness endpoint: a broken DNS
 * resolver or an unavailable third-party API must be reported as a dependency
 * failure, not as a dead Primary Node.
 */

import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';

export type ProbeStatus = 'healthy' | 'degraded' | 'unhealthy' | 'skipped';

export type ProbeErrorType =
  | 'dns_resolution'
  | 'connection_refused'
  | 'connection_timeout'
  | 'connection_reset'
  | 'http_4xx'
  | 'http_5xx'
  | 'http_error'
  | 'invalid_target';

export interface HealthProbeResult {
  status: ProbeStatus;
  target?: string;
  resolvedAddresses?: string[];
  phase?: 'dns' | 'tcp' | 'http';
  httpStatus?: number;
  durationMs?: number;
  errorType?: ProbeErrorType;
  error?: string;
}

export interface DeliveryHealth {
  status: 'healthy' | 'degraded' | 'unknown';
  attempts: number;
  successes: number;
  failures: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastErrorType?: ProbeErrorType | 'delivery_error';
}

export interface NetworkProbeOptions {
  name: string;
  url?: string;
  timeoutMs?: number;
}

function errorTypeFor(error: NodeJS.ErrnoException, phase: HealthProbeResult['phase']): ProbeErrorType {
  if (phase === 'dns' || error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
    return 'dns_resolution';
  }
  if (error.code === 'ECONNREFUSED') {
    return 'connection_refused';
  }
  if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
    return 'connection_timeout';
  }
  if (error.code === 'ECONNRESET') {
    return 'connection_reset';
  }
  return 'http_error';
}

/** Probe DNS and then the HTTP(S) endpoint, recording the failing phase. */
export async function probeNetworkEndpoint(options: NetworkProbeOptions): Promise<HealthProbeResult> {
  if (!options.url) {
    return { status: 'skipped' };
  }

  const startedAt = Date.now();
  let target: URL;
  try {
    target = new URL(options.url);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error('only http and https targets are supported');
    }
  } catch (error) {
    return {
      status: 'unhealthy',
      target: options.url,
      durationMs: Date.now() - startedAt,
      phase: 'dns',
      errorType: 'invalid_target',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let addresses: LookupAddress[];
  try {
    addresses = await dns.lookup(target.hostname, { all: true });
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException;
    return {
      status: 'unhealthy',
      target: options.url,
      durationMs: Date.now() - startedAt,
      phase: 'dns',
      errorType: errorTypeFor(typedError, 'dns'),
      error: typedError.message || String(error),
    };
  }

  const transport = target.protocol === 'https:' ? https : http;
  const timeoutMs = options.timeoutMs ?? 5_000;
  return await new Promise<HealthProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: HealthProbeResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        target: options.url,
        resolvedAddresses: addresses.map((address) => address.address),
        durationMs: Date.now() - startedAt,
        ...result,
      });
    };

    const request = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: { accept: 'application/json, text/plain, */*' },
        timeout: timeoutMs,
        lookup: (_hostname, _options, callback) => {
          const [address] = addresses;
          callback(null, address.address, address.family);
        },
      },
      (response) => {
        response.resume();
        const statusCode = response.statusCode ?? 0;
        if (statusCode >= 500) {
          finish({ status: 'unhealthy', phase: 'http', httpStatus: statusCode, errorType: 'http_5xx' });
        } else if (statusCode >= 400) {
          finish({ status: 'degraded', phase: 'http', httpStatus: statusCode, errorType: 'http_4xx' });
        } else {
          finish({ status: 'healthy', phase: 'http', httpStatus: statusCode });
        }
      },
    );

    request.on('timeout', () => {
      request.destroy(Object.assign(new Error(`request timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
    });
    request.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        status: 'unhealthy',
        phase: 'tcp',
        errorType: errorTypeFor(error, 'tcp'),
        error: error.message || String(error),
      });
    });
    request.end();
  });
}
