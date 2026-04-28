/**
 * Network diagnostics utility for capturing TCP connection state.
 *
 * Issue #2992: When the SDK subprocess hangs due to a frozen TCP connection
 * to the LiteLLM proxy, we need diagnostic information to understand why.
 *
 * This module provides functions to capture TCP connection states, process
 * information, and format them for logging. Used when a session activity
 * timeout is detected.
 *
 * Cross-platform: works on macOS (netstat, lsof) and Linux (ss, lsof).
 */

import { execSync } from 'node:child_process';
import { createLogger } from './logger.js';

const logger = createLogger('network-diagnostics');

/**
 * Information about a single TCP connection.
 */
export interface TcpConnectionInfo {
  /** Protocol (tcp4, tcp6) */
  protocol: string;
  /** Local address:port */
  localAddress: string;
  /** Foreign address:port */
  foreignAddress: string;
  /** Connection state (ESTABLISHED, CLOSE_WAIT, etc.) */
  state: string;
}

/**
 * Network diagnostic snapshot.
 */
export interface NetworkDiagnostics {
  /** Timestamp of the diagnostics capture */
  timestamp: string;
  /** TCP connections to the API endpoint, filtered by target host */
  apiConnections: TcpConnectionInfo[];
  /** Raw output from netstat/ss (truncated) */
  rawOutput?: string;
  /** Error message if capture failed */
  error?: string;
}

/**
 * Capture TCP connections filtered by an optional target host.
 *
 * Uses `netstat -an` on macOS and `ss -an` on Linux.
 *
 * @param targetHost - Optional host:port to filter connections (e.g., '192.168.5.183:4000')
 * @returns NetworkDiagnostics snapshot
 */
export function captureTcpConnections(targetHost?: string): NetworkDiagnostics {
  const timestamp = new Date().toISOString();

  try {
    const rawOutput = runNetstat();
    const allConnections = parseNetstatOutput(rawOutput);
    const apiConnections = targetHost
      ? allConnections.filter(c => c.foreignAddress.includes(targetHost))
      : allConnections;

    return {
      timestamp,
      apiConnections,
      rawOutput: truncate(rawOutput, 2000),
    };
  } catch (error) {
    const err = error as Error;
    logger.warn({ err }, 'Failed to capture TCP connections');
    return {
      timestamp,
      apiConnections: [],
      error: err.message,
    };
  }
}

/**
 * Capture diagnostic information about a specific process.
 *
 * @param pid - Process ID to check
 * @returns Process info string or undefined if unavailable
 */
export function captureProcessInfo(pid?: number): string | undefined {
  if (!pid) {return undefined;}

  try {
    // Use ps to get process state
    const output = execSync(
      `ps -p ${pid} -o pid,state,%cpu,%mem,etime 2>/dev/null || true`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Format network diagnostics for logging.
 *
 * @param diagnostics - The diagnostics to format
 * @returns Formatted string suitable for structured logging
 */
export function formatDiagnostics(diagnostics: NetworkDiagnostics): string {
  const lines: string[] = [
    `Network Diagnostics @ ${diagnostics.timestamp}`,
  ];

  if (diagnostics.error) {
    lines.push(`  Error: ${diagnostics.error}`);
    return lines.join('\n');
  }

  lines.push(`  API connections: ${diagnostics.apiConnections.length}`);
  for (const conn of diagnostics.apiConnections) {
    lines.push(`    ${conn.protocol} ${conn.localAddress} → ${conn.foreignAddress} [${conn.state}]`);
  }

  if (diagnostics.rawOutput) {
    lines.push('  Raw output (first 500 chars):');
    lines.push(`    ${truncate(diagnostics.rawOutput, 500)}`);
  }

  return lines.join('\n');
}

/**
 * Run netstat or ss command to get TCP connection list.
 */
function runNetstat(): string {
  const {platform} = process;

  try {
    if (platform === 'darwin') {
      // macOS: netstat -an (list all connections, numeric)
      return execSync('netstat -an 2>/dev/null', {
        encoding: 'utf8',
        timeout: 10000,
      });
    } else {
      // Linux: ss -an (list all sockets, numeric)
      return execSync('ss -an 2>/dev/null || netstat -an 2>/dev/null', {
        encoding: 'utf8',
        timeout: 10000,
      });
    }
  } catch {
    // Fallback: try the other command
    try {
      return execSync('netstat -an 2>/dev/null || echo "netstat-unavailable"', {
        encoding: 'utf8',
        timeout: 10000,
      });
    } catch {
      return 'netstat-unavailable';
    }
  }
}

/**
 * Parse netstat/ss output into structured connection info.
 */
function parseNetstatOutput(output: string): TcpConnectionInfo[] {
  const connections: TcpConnectionInfo[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {continue;}

    // netstat format: tcp4 0 0 192.168.1.2.50148 192.168.5.183.4000 ESTABLISHED
    // or: tcp   0   0 192.168.1.2:50148    192.168.5.183:4000    ESTABLISHED
    const tcpMatch = trimmed.match(
      /^(tcp[46]?)\s+\d+\s+\d+\s+(\S+)\s+(\S+)\s+(\S+)/
    );
    if (tcpMatch) {
      connections.push({
        protocol: tcpMatch[1],
        localAddress: tcpMatch[2],
        foreignAddress: tcpMatch[3],
        state: tcpMatch[4],
      });
      continue;
    }

    // ss format: ESTAB  0  0  192.168.1.2:50148  192.168.5.183:4000
    const ssMatch = trimmed.match(
      /^(ESTAB|TIME-WAIT|CLOSE-WAIT|SYN-SENT|SYN-RECV|FIN-WAIT-\d|LAST-ACK|LISTEN|UNCONN)\s+\d+\s+\d+\s+(\S+)\s+(\S+)/
    );
    if (ssMatch) {
      const stateMap: Record<string, string> = {
        'ESTAB': 'ESTABLISHED',
        'TIME-WAIT': 'TIME_WAIT',
        'CLOSE-WAIT': 'CLOSE_WAIT',
        'SYN-SENT': 'SYN_SENT',
        'SYN-RECV': 'SYN_RECV',
        'LAST-ACK': 'LAST_ACK',
        'LISTEN': 'LISTEN',
        'UNCONN': 'UNCONN',
      };
      connections.push({
        protocol: 'tcp',
        localAddress: ssMatch[2],
        foreignAddress: ssMatch[3],
        state: stateMap[ssMatch[1]] || ssMatch[1],
      });
    }
  }

  return connections;
}

/**
 * Truncate a string to a maximum length.
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {return str;}
  return `${str.substring(0, maxLength)  }... (truncated)`;
}
