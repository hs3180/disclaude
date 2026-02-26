import { describe, it, expect } from 'vitest';
import {
  TOOL_FALLBACK_CHAINS,
  isRateLimitError,
  getFallbackForTool,
  generateFallbackErrorMessage,
  getToolsWithFallbacks,
} from './tool-fallback.js';

describe('tool-fallback', () => {
  describe('TOOL_FALLBACK_CHAINS', () => {
    it('should define fallback chains for WebSearch', () => {
      expect(TOOL_FALLBACK_CHAINS.WebSearch).toBeDefined();
      expect(TOOL_FALLBACK_CHAINS.WebSearch.fallbacks.length).toBeGreaterThan(0);
      expect(TOOL_FALLBACK_CHAINS.WebSearch.description).toBe('Web search functionality');
    });

    it('should define fallback chains for webReader', () => {
      expect(TOOL_FALLBACK_CHAINS['mcp__web_reader__webReader']).toBeDefined();
      expect(TOOL_FALLBACK_CHAINS['mcp__web_reader__webReader'].fallbacks.length).toBeGreaterThan(0);
    });

    it('should define fallback chains for WebFetch', () => {
      expect(TOOL_FALLBACK_CHAINS.WebFetch).toBeDefined();
      expect(TOOL_FALLBACK_CHAINS.WebFetch.fallbacks.length).toBeGreaterThan(0);
    });

    it('should have rate limit patterns for each tool', () => {
      for (const [toolName, chain] of Object.entries(TOOL_FALLBACK_CHAINS)) {
        expect(chain.rateLimitPatterns).toBeDefined();
        expect(chain.rateLimitPatterns.length).toBeGreaterThan(0);
      }
    });
  });

  describe('isRateLimitError', () => {
    it('should detect weekly usage limit errors', () => {
      expect(isRateLimitError('WebSearch', 'The search tool has reached its weekly usage limit')).toBe(true);
    });

    it('should detect monthly usage limit errors', () => {
      expect(isRateLimitError('WebSearch', 'Monthly usage limit exceeded')).toBe(true);
    });

    it('should detect rate limit errors', () => {
      expect(isRateLimitError('WebFetch', 'Rate limit exceeded, please try again later')).toBe(true);
    });

    it('should detect quota exceeded errors', () => {
      expect(isRateLimitError('mcp__web_reader__webReader', 'Quota exceeded for this period')).toBe(true);
    });

    it('should detect "won\'t be available until" pattern', () => {
      expect(isRateLimitError('WebSearch', "won't be available until March 8, 2026")).toBe(true);
    });

    it('should return false for non-rate-limit errors', () => {
      expect(isRateLimitError('WebSearch', 'Network connection failed')).toBe(false);
    });

    it('should return false for unknown tools with non-rate-limit errors', () => {
      expect(isRateLimitError('UnknownTool', 'Some random error')).toBe(false);
    });

    it('should detect generic rate limit patterns for unknown tools', () => {
      expect(isRateLimitError('UnknownTool', 'rate limit exceeded')).toBe(true);
      expect(isRateLimitError('UnknownTool', 'usage limit reached')).toBe(true);
    });
  });

  describe('getFallbackForTool', () => {
    it('should return fallback chain for WebSearch', () => {
      const chain = getFallbackForTool('WebSearch');
      expect(chain).toBeDefined();
      expect(chain?.description).toBe('Web search functionality');
    });

    it('should return undefined for unknown tools', () => {
      const chain = getFallbackForTool('NonExistentTool');
      expect(chain).toBeUndefined();
    });
  });

  describe('generateFallbackErrorMessage', () => {
    it('should generate enhanced error message with fallbacks for WebSearch', () => {
      const message = generateFallbackErrorMessage(
        'WebSearch',
        'The search tool has reached its weekly usage limit'
      );

      expect(message).toContain('⚠️');
      expect(message).toContain('WebSearch');
      expect(message).toContain('weekly usage limit');
      expect(message).toContain('Alternative approaches');
      expect(message).toContain('Playwright');
    });

    it('should include multiple fallback options when available', () => {
      const message = generateFallbackErrorMessage(
        'WebFetch',
        'Rate limit exceeded'
      );

      expect(message).toContain('Playwright');
      expect(message).toContain('curl');
    });

    it('should return message without fallbacks for unknown tools', () => {
      const message = generateFallbackErrorMessage(
        'UnknownTool',
        'Some error occurred'
      );

      expect(message).toContain('⚠️');
      expect(message).toContain('UnknownTool');
      expect(message).toContain('No automatic fallback');
    });
  });

  describe('getToolsWithFallbacks', () => {
    it('should return list of tools with fallback support', () => {
      const tools = getToolsWithFallbacks();

      expect(tools).toContain('WebSearch');
      expect(tools).toContain('mcp__web_reader__webReader');
      expect(tools).toContain('WebFetch');
      expect(tools.length).toBeGreaterThanOrEqual(3);
    });
  });
});
