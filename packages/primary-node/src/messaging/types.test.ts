/**
 * Tests for messaging types (packages/primary-node/src/messaging/types.ts)
 *
 * Covers:
 * - mapAgentMessageTypeToLevel(): message type to level mapping
 *
 * @see Issue #1617 Phase 4
 */

import { describe, it, expect } from 'vitest';
import { mapAgentMessageTypeToLevel, MessageLevel } from './types.js';

describe('mapAgentMessageTypeToLevel', () => {
  it('should map tool_progress to PROGRESS', () => {
    expect(mapAgentMessageTypeToLevel('tool_progress')).toBe(MessageLevel.PROGRESS);
  });

  it('should map tool_use to DEBUG', () => {
    expect(mapAgentMessageTypeToLevel('tool_use')).toBe(MessageLevel.DEBUG);
  });

  it('should map tool_result to DEBUG', () => {
    expect(mapAgentMessageTypeToLevel('tool_result')).toBe(MessageLevel.DEBUG);
  });

  it('should map error to ERROR', () => {
    expect(mapAgentMessageTypeToLevel('error')).toBe(MessageLevel.ERROR);
  });

  it('should map result to RESULT', () => {
    expect(mapAgentMessageTypeToLevel('result')).toBe(MessageLevel.RESULT);
  });

  it('should map result with completion prefix to DEBUG', () => {
    expect(mapAgentMessageTypeToLevel('result', '✅ Complete')).toBe(MessageLevel.DEBUG);
  });

  it('should map result without completion prefix to RESULT', () => {
    expect(mapAgentMessageTypeToLevel('result', 'Some other text')).toBe(MessageLevel.RESULT);
  });

  it('should map notification to NOTICE', () => {
    expect(mapAgentMessageTypeToLevel('notification')).toBe(MessageLevel.NOTICE);
  });

  it('should map task_completion to RESULT', () => {
    expect(mapAgentMessageTypeToLevel('task_completion')).toBe(MessageLevel.RESULT);
  });

  it('should map max_iterations_warning to IMPORTANT', () => {
    expect(mapAgentMessageTypeToLevel('max_iterations_warning')).toBe(MessageLevel.IMPORTANT);
  });

  it('should map status to INFO', () => {
    expect(mapAgentMessageTypeToLevel('status')).toBe(MessageLevel.INFO);
  });

  it('should map text to INFO', () => {
    expect(mapAgentMessageTypeToLevel('text')).toBe(MessageLevel.INFO);
  });

  it('should map unknown type to INFO', () => {
    expect(mapAgentMessageTypeToLevel('unknown_type' as any)).toBe(MessageLevel.INFO);
  });

  it('should handle result with no content', () => {
    expect(mapAgentMessageTypeToLevel('result', undefined)).toBe(MessageLevel.RESULT);
  });

  it('should handle result with empty string', () => {
    expect(mapAgentMessageTypeToLevel('result', '')).toBe(MessageLevel.RESULT);
  });
});
