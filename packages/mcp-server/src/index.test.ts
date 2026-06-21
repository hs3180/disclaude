/**
 * Tests for the package entrypoint (packages/mcp-server/src/index.ts).
 *
 * Guards against version drift: ensures the exported MCP_SERVER_VERSION
 * stays in sync with the version declared in package.json, regardless of
 * how it is sourced (imported JSON, createRequire, etc.).
 *
 * @module mcp-server/index
 */

import { describe, it, expect } from 'vitest';
import { MCP_SERVER_VERSION } from './index.js';
import pkg from '../package.json' with { type: 'json' };

describe('MCP_SERVER_VERSION', () => {
  it('matches the version declared in package.json', () => {
    expect(MCP_SERVER_VERSION).toBe(pkg.version);
  });

  it('is a non-empty semver string', () => {
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
