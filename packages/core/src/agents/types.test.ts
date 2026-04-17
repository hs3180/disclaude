/**
 * Unit tests for Agent type definitions and type guards
 *
 * Issue #1501: Simplified to ChatAgent-only architecture.
 * SkillAgent and Subagent type guards have been removed.
 *
 * Issue #2345 Phase 4: Runtime context tests moved to runtime-context.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  isChatAgent,
  isDisposable,
  type ChatAgent,
  type Disposable,
} from './types.js';

describe('Type Guards', () => {
  describe('isChatAgent', () => {
    it('should return true for valid ChatAgent', () => {
      const chatAgent: ChatAgent = {
        type: 'chat',
        name: 'test-agent',
        async start() {},
        async *handleInput() {},
        processMessage() {},
        async executeOnce() {},
        reset() {},
        stop() { return true; },
        dispose() {},
      };

      expect(isChatAgent(chatAgent)).toBe(true);
    });

    it('should return false for null', () => {
      expect(isChatAgent(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isChatAgent(undefined)).toBe(false);
    });

    it('should return false for non-object types', () => {
      expect(isChatAgent('string')).toBe(false);
      expect(isChatAgent(123)).toBe(false);
      expect(isChatAgent(true)).toBe(false);
    });

    it('should return false for wrong type', () => {
      const otherType = { type: 'skill', name: 'test' };
      expect(isChatAgent(otherType)).toBe(false);
    });

    it('should return false for object without type', () => {
      expect(isChatAgent({})).toBe(false);
      expect(isChatAgent({ name: 'test' })).toBe(false);
    });
  });

  describe('isDisposable', () => {
    it('should return true for object with dispose method', () => {
      const disposable: Disposable = {
        dispose: () => {},
      };

      expect(isDisposable(disposable)).toBe(true);
    });

    it('should return true for ChatAgent (which is Disposable)', () => {
      const chatAgent: ChatAgent = {
        type: 'chat',
        name: 'test-agent',
        async start() {},
        async *handleInput() {},
        processMessage() {},
        async executeOnce() {},
        reset() {},
        stop() { return true; },
        dispose() {},
      };

      expect(isDisposable(chatAgent)).toBe(true);
    });

    it('should return false for null', () => {
      expect(isDisposable(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isDisposable(undefined)).toBe(false);
    });

    it('should return false for object without dispose', () => {
      expect(isDisposable({})).toBe(false);
      expect(isDisposable({ name: 'test' })).toBe(false);
    });

    it('should return false when dispose is not a function', () => {
      const invalidDisposable = {
        dispose: 'not a function',
      };

      expect(isDisposable(invalidDisposable)).toBe(false);
    });
  });
});
