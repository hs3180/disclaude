import { describe, it, expect } from 'vitest';
import {
  isToolLimitError,
  getFallbackSuggestion,
  formatLimitMessage,
} from './tool-fallback-guide.js';

describe('tool-fallback-guide', () => {
  describe('isToolLimitError', () => {
    it('should detect usage limit errors', () => {
      expect(isToolLimitError('The search tool has reached its weekly usage limit')).toBe(true);
      expect(isToolLimitError('Monthly usage limit exceeded')).toBe(true);
      expect(isToolLimitError('API quota exceeded for this tool')).toBe(true);
      expect(isToolLimitError('Rate limit reached, please try again later')).toBe(true);
    });

    it('should not detect non-limit errors', () => {
      expect(isToolLimitError('Network connection failed')).toBe(false);
      expect(isToolLimitError('Invalid parameter provided')).toBe(false);
      expect(isToolLimitError('Authentication error')).toBe(false);
    });

    it('should detect case-insensitively', () => {
      expect(isToolLimitError('USAGE LIMIT REACHED')).toBe(true);
      expect(isToolLimitError('Weekly Limit')).toBe(true);
    });
  });

  describe('getFallbackSuggestion', () => {
    it('should return fallback for WebSearch', () => {
      const suggestion = getFallbackSuggestion('WebSearch');
      expect(suggestion).toContain('Playwright');
      expect(suggestion).toContain('search engine');
    });

    it('should return fallback for WebFetch', () => {
      const suggestion = getFallbackSuggestion('WebFetch');
      expect(suggestion).toContain('browser_navigate');
      expect(suggestion).toContain('browser_snapshot');
    });

    it('should return fallback for webReader', () => {
      const suggestion = getFallbackSuggestion('mcp__web_reader__webReader');
      expect(suggestion).toContain('browser_navigate');
    });

    it('should return null for unknown tools', () => {
      expect(getFallbackSuggestion('UnknownTool')).toBeNull();
      expect(getFallbackSuggestion('Bash')).toBeNull();
    });
  });

  describe('formatLimitMessage', () => {
    it('should format WebSearch limit message with fallback', () => {
      const message = formatLimitMessage('WebSearch', 'weekly limit reached');
      expect(message).toContain('WebSearch');
      expect(message).toContain('Playwright');
      expect(message).toContain('weekly limit reached');
    });

    it('should format unknown tool limit message without fallback', () => {
      const message = formatLimitMessage('UnknownTool', 'some error');
      expect(message).toContain('UnknownTool');
      expect(message).toContain('some error');
      expect(message).toContain('try to proceed');
    });
  });
});
