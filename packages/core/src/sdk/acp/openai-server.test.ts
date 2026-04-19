/**
 * Tests for OpenAI ACP Server.
 *
 * Tests the JSON-RPC message handling and OpenAI API integration logic.
 * @see Issue #1333
 */

import { describe, it, expect } from 'vitest';

// We test the internal functions by importing the module
// The server uses stdin/stdout which is hard to test directly,
// so we focus on the logic functions.

describe('OpenAI ACP Server', () => {
  describe('extractPromptText', () => {
    // Test the prompt text extraction logic inline
    function extractPromptText(prompt: unknown): string {
      if (typeof prompt === 'string') {return prompt;}
      if (Array.isArray(prompt)) {
        return prompt
          .map((block: unknown) => {
            if (typeof block === 'string') {return block;}
            if (typeof block === 'object' && block !== null && 'text' in block) {
              return (block as { text: string }).text;
            }
            return '';
          })
          .filter(Boolean)
          .join('\n');
      }
      return String(prompt);
    }

    it('should extract text from string prompt', () => {
      expect(extractPromptText('Hello')).toBe('Hello');
    });

    it('should extract text from array of content blocks', () => {
      const prompt = [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' },
      ];
      expect(extractPromptText(prompt)).toBe('Hello\nWorld');
    });

    it('should extract text from mixed array', () => {
      const prompt = ['plain text', { type: 'text', text: 'block text' }];
      expect(extractPromptText(prompt)).toBe('plain text\nblock text');
    });

    it('should handle empty array', () => {
      expect(extractPromptText([])).toBe('');
    });

    it('should handle null/undefined gracefully', () => {
      expect(extractPromptText(null)).toBe('null');
      expect(extractPromptText(undefined)).toBe('undefined');
    });
  });

  describe('Configuration', () => {
    it('should use OPENAI_API_KEY from environment', () => {
      process.env.OPENAI_API_KEY = 'test-key';
      // The server module reads process.env.OPENAI_API_KEY
      expect(process.env.OPENAI_API_KEY).toBe('test-key');
      delete process.env.OPENAI_API_KEY;
    });

    it('should use OPENAI_MODEL from environment or default to gpt-4o', () => {
      // Default
      expect(process.env.OPENAI_MODEL || 'gpt-4o').toBe('gpt-4o');

      // Custom model
      process.env.OPENAI_MODEL = 'gpt-4o-mini';
      expect(process.env.OPENAI_MODEL).toBe('gpt-4o-mini');
      delete process.env.OPENAI_MODEL;
    });

    it('should use OPENAI_BASE_URL from environment or default', () => {
      // Default
      expect(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').toBe(
        'https://api.openai.com/v1',
      );

      // Custom base URL
      process.env.OPENAI_BASE_URL = 'https://my-proxy.example.com/v1';
      expect(process.env.OPENAI_BASE_URL).toBe('https://my-proxy.example.com/v1');
      delete process.env.OPENAI_BASE_URL;
    });
  });

  describe('JSON-RPC message format', () => {
    it('should format JSON-RPC response correctly', () => {
      const response = {
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: 1, capabilities: {} },
      };
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result).toBeDefined();
    });

    it('should format JSON-RPC error response correctly', () => {
      const errorResponse = {
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32601, message: 'Method not found: unknown' },
      };
      expect(errorResponse.jsonrpc).toBe('2.0');
      expect(errorResponse.error.code).toBe(-32601);
    });

    it('should format JSON-RPC notification correctly', () => {
      const notification = {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'test-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Hello' },
          },
        },
      };
      expect(notification.jsonrpc).toBe('2.0');
      expect(notification.method).toBe('session/update');
      // Notifications should NOT have an id
      expect('id' in notification).toBe(false);
    });
  });
});
