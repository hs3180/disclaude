/**
 * Tests for non-Anthropic endpoint system tools.
 *
 * Issue #2948: GLM endpoints don't parse tool definitions from system prompt.
 * These tests verify the MCP inline tools that replicate Claude Code's built-in tools.
 */

import { describe, it, expect } from 'vitest';
import { isNonAnthropicEndpoint } from './non-anthropic-tools.js';

describe('isNonAnthropicEndpoint', () => {
  it('should return false for api.anthropic.com', () => {
    expect(isNonAnthropicEndpoint('https://api.anthropic.com')).toBe(false);
  });

  it('should return false for api-staging.anthropic.com', () => {
    expect(isNonAnthropicEndpoint('https://api-staging.anthropic.com')).toBe(false);
  });

  it('should return true for GLM endpoint', () => {
    expect(isNonAnthropicEndpoint('https://open.bigmodel.cn/api/anthropic')).toBe(true);
  });

  it('should return true for custom endpoint', () => {
    expect(isNonAnthropicEndpoint('https://my-custom-api.example.com/v1')).toBe(true);
  });

  it('should return true for localhost', () => {
    expect(isNonAnthropicEndpoint('http://localhost:8080')).toBe(true);
  });

  it('should return true for invalid URL', () => {
    expect(isNonAnthropicEndpoint('not-a-valid-url')).toBe(true);
  });

  it('should return false for Anthropic URL with path', () => {
    expect(isNonAnthropicEndpoint('https://api.anthropic.com/v1/messages')).toBe(false);
  });

  it('should return true for similar but non-Anthropic domain', () => {
    expect(isNonAnthropicEndpoint('https://api.anthropic.example.com')).toBe(true);
  });
});
