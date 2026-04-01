/**
 * Tests for start_discussion tool (packages/mcp-server/src/tools/start-discussion.ts)
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 */

import { describe, it, expect } from 'vitest';

// Test the tool's parameter validation logic by testing the exported function
// Since we can't use vi.mock() for external SDKs, we test validation paths
// that don't require IPC.

describe('start_discussion', () => {
  describe('parameter validation', () => {
    it('should return error when context is empty string', async () => {
      const { start_discussion } = await import('./start-discussion.js');
      const result = await start_discussion({ context: '' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('context is required');
      expect(result.message).toContain('context');
    });

    it('should return error when context is not provided', async () => {
      const { start_discussion } = await import('./start-discussion.js');
      // @ts-expect-error - Testing missing required parameter
      const result = await start_discussion({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('context is required');
    });

    it('should return error when context is non-string type', async () => {
      const { start_discussion } = await import('./start-discussion.js');
      // @ts-expect-error - Testing wrong type
      const result = await start_discussion({ context: 123 });

      expect(result.success).toBe(false);
      expect(result.error).toContain('context is required');
    });
  });

  describe('IPC availability check', () => {
    it('should return IPC unavailable error when IPC is not reachable', async () => {
      // In test environment, IPC socket doesn't exist, so isIpcAvailable returns false
      const { start_discussion } = await import('./start-discussion.js');
      const result = await start_discussion({ context: 'Test discussion context' });

      // Without a running IPC server, this should fail with IPC unavailable
      expect(result.success).toBe(false);
      expect(result.message).toContain('IPC');
    });
  });

  describe('result type structure', () => {
    it('should return StartDiscussionResult with correct shape on validation failure', async () => {
      const { start_discussion } = await import('./start-discussion.js');
      const result = await start_discussion({ context: '' });

      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('error');
      expect(typeof result.success).toBe('boolean');
      expect(typeof result.message).toBe('string');
      expect(typeof result.error).toBe('string');
    });
  });
});
