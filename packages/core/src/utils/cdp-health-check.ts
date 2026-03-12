/**
 * CDP (Chrome DevTools Protocol) endpoint health check utility.
 *
 * Used to verify that Chrome remote debugging is available before
 * starting Playwright MCP server.
 *
 * @module utils/cdp-health-check
 */

import { createLogger } from './logger.js';

const logger = createLogger('CdpHealthCheck');

/**
 * CDP endpoint health check result.
 */
export interface CdpHealthCheckResult {
  /** Whether the endpoint is healthy */
  healthy: boolean;
  /** Error message if unhealthy */
  error?: string;
  /** Suggested fix for the error */
  suggestion?: string;
  /** Endpoint URL that was checked */
  endpoint?: string;
}

/**
 * Parse CDP endpoint URL from Playwright MCP args.
 *
 * @param args - Playwright MCP command line arguments
 * @returns CDP endpoint URL or undefined if not found
 */
export function parseCdpEndpoint(args: string[] = []): string | undefined {
  // Look for --cdp-endpoint=<url> or --cdp-endpoint <url>
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--cdp-endpoint=')) {
      return arg.split('=')[1];
    }
    if (arg === '--cdp-endpoint' && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return undefined;
}

/**
 * Check if a CDP endpoint is healthy.
 *
 * This function attempts to connect to the Chrome DevTools Protocol
 * endpoint to verify that Chrome remote debugging is running.
 *
 * @param endpoint - CDP endpoint URL (e.g., http://localhost:9222)
 * @returns Health check result
 */
export async function checkCdpEndpointHealth(endpoint: string): Promise<CdpHealthCheckResult> {
  logger.debug({ endpoint }, 'Checking CDP endpoint health');

  try {
    // Try to fetch the JSON version info from Chrome
    const versionUrl = `${endpoint.replace(/\/$/, '')}/json/version`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(versionUrl, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        healthy: false,
        error: `CDP endpoint returned status ${response.status}`,
        suggestion: 'Ensure Chrome is running with remote debugging enabled',
        endpoint,
      };
    }

    const data = await response.json() as { Browser?: string };

    logger.debug({ endpoint, browser: data.Browser }, 'CDP endpoint is healthy');

    return {
      healthy: true,
      endpoint,
    };
  } catch (error) {
    const err = error as Error;

    // Provide specific error messages and suggestions
    if (err.name === 'AbortError') {
      return {
        healthy: false,
        error: 'Connection timeout (5s)',
        suggestion: 'Chrome may be slow to respond. Check if Chrome is running properly.',
        endpoint,
      };
    }

    if (err.message.includes('ECONNREFUSED') || err.message.includes('connection refused')) {
      return {
        healthy: false,
        error: 'Connection refused - Chrome is not running or remote debugging is not enabled',
        suggestion: `Start Chrome with remote debugging:
  macOS: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222
  Linux: google-chrome --remote-debugging-port=9222
  Windows: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222`,
        endpoint,
      };
    }

    if (err.message.includes('ENOTFOUND') || err.message.includes('dns')) {
      return {
        healthy: false,
        error: 'DNS resolution failed - invalid hostname',
        suggestion: 'Check the CDP endpoint URL in your configuration',
        endpoint,
      };
    }

    // Generic error
    return {
      healthy: false,
      error: err.message,
      suggestion: 'Ensure Chrome is running with remote debugging enabled on the specified port',
      endpoint,
    };
  }
}

/**
 * Format a CDP health check error for display.
 *
 * @param result - Unhealthy health check result
 * @returns Formatted error message
 */
export function formatCdpHealthError(result: CdpHealthCheckResult): string {
  const lines = [
    '❌ **Playwright MCP: CDP Endpoint Unavailable**',
    '',
    `**Error**: ${result.error}`,
    `**Endpoint**: ${result.endpoint || 'unknown'}`,
    '',
    '**How to fix**:',
  ];

  if (result.suggestion) {
    // Add each line of suggestion with proper indentation
    lines.push(...result.suggestion.split('\n').map(line => `  ${line}`));
  }

  return lines.join('\n');
}
