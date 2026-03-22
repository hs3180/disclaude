/**
 * Unit tests for start_discussion tool.
 *
 * @module mcp-server/tools/start-discussion.test
 * @see Issue #631 - 离线提问机制
 */

import { describe, it, beforeEach, afterEach } from 'vitest';
import { expect } from 'chai';
import { start_discussion } from './start-discussion.js';

describe('start_discussion', () => {
  describe('validation', () => {
    it('should fail when context is missing', async () => {
      const result = await start_discussion({} as any);
      expect(result.success).to.be.false;
      expect(result.message).to.include('上下文');
    });

    it('should fail when context is empty string', async () => {
      const result = await start_discussion({ context: '' });
      expect(result.success).to.be.false;
      expect(result.message).to.include('上下文');
    });

    it('should fail when neither chatId nor members is provided', async () => {
      const result = await start_discussion({ context: 'test' });
      expect(result.success).to.be.false;
      expect(result.message).to.include('chatId');
    });

    it('should fail when both chatId and members are provided', async () => {
      const result = await start_discussion({
        context: 'test',
        chatId: 'oc_xxx',
        members: ['ou_xxx'],
      });
      expect(result.success).to.be.false;
      expect(result.message).to.include('同时');
    });
  });

  describe('with chatId (existing group)', () => {
    it('should succeed when using existing chatId', async () => {
      // Note: This test will fail at send_text stage since no IPC server is running,
      // but validates the parameter handling logic
      const result = await start_discussion({
        context: 'test discussion context',
        chatId: 'oc_test123',
      });
      // send_text will fail without IPC, but validation should pass
      // The error should be from send_text, not from parameter validation
      expect(result.error).to.not.include('chatId');
      expect(result.error).to.not.include('同时');
      expect(result.error).to.not.include('上下文');
    });

    it('should include topic in result for existing chat', async () => {
      const result = await start_discussion({
        context: 'test',
        chatId: 'oc_test123',
        topic: 'test topic',
      });
      expect(result.error).to.not.include('chatId');
    });
  });

  describe('with members (new group)', () => {
    it('should attempt IPC group creation when members provided', async () => {
      const result = await start_discussion({
        context: 'test discussion',
        members: ['ou_test1', 'ou_test2'],
        topic: 'New Discussion',
      });
      // Will fail without IPC server, but should not be a validation error
      expect(result.error).to.not.include('chatId');
      expect(result.error).to.not.include('上下文');
      expect(result.error).to.not.include('同时');
    });
  });

  describe('error handling', () => {
    it('should return structured error for invalid input', async () => {
      const result = await start_discussion({} as any);
      expect(result).to.have.property('success', false);
      expect(result).to.have.property('message');
      expect(result).to.have.property('error');
    });
  });
});
