/**
 * Tests for prompt builder (src/task/prompt-builder.ts)
 *
 * Tests the following functionality:
 * - Building scout prompts with task context
 * - Placeholder replacement
 * - Direct template usage (not extracted from skill files)
 */

import { describe, it, expect } from 'vitest';
import {
  buildScoutPrompt,
  type TaskContext,
} from './prompt-builder.js';

describe('buildScoutPrompt', () => {
  const mockTaskContext: TaskContext = {
    chatId: 'oc_test123',
    userId: 'ou_user456',
    messageId: 'om_msg789',
    taskPath: '/workspace/tasks/om_msg789',
  };

  it('should replace all placeholders in direct template', () => {
    const result = buildScoutPrompt('Test prompt', mockTaskContext);

    expect(result).toContain('Message ID**: om_msg789');
    expect(result).toContain('Task Path**: /workspace/tasks/om_msg789');
    expect(result).toContain('Chat ID**: oc_test123');
    expect(result).toContain('User ID**: ou_user456');
    expect(result).toContain('Test prompt');
  });

  it('should handle missing userId', () => {
    const taskContextWithoutUser: TaskContext = {
      chatId: 'oc_test123',
      messageId: 'om_msg789',
      taskPath: '/workspace/tasks/om_msg789',
    };

    const result = buildScoutPrompt('Test', taskContextWithoutUser);

    expect(result).toContain('User ID**: N/A');
  });

  it('should use direct template (skillContent parameter is ignored)', () => {
    // The third parameter (skillContent) is now ignored
    const result = buildScoutPrompt('Test prompt', mockTaskContext, 'ignored content');

    expect(result).toContain('om_msg789');
    expect(result).toContain('/workspace/tasks/om_msg789');
    expect(result).toContain('oc_test123');
    expect(result).toContain('Test prompt');
  });

  it('should return userPrompt when taskContext is missing', () => {
    const result = buildScoutPrompt('Just the prompt', null as unknown as TaskContext);

    expect(result).toBe('Just the prompt');
  });

  it('should handle empty userPrompt', () => {
    const result = buildScoutPrompt('', mockTaskContext);

    expect(result).toContain('```');
    expect(result).toContain('```');
  });

  it('should include all required sections from direct template', () => {
    const result = buildScoutPrompt('Analyze code', mockTaskContext);

    expect(result).toContain('## Task Context');
    expect(result).toContain('## User Request');
    expect(result).toContain('## Your Instruction');
    expect(result).toContain('task initialization specialist');
    expect(result).toContain('Expected Results');
  });

  it('should preserve special characters in userPrompt', () => {
    const specialPrompt = 'Fix bug in `handler.ts` - check for **null** values';
    const result = buildScoutPrompt(specialPrompt, mockTaskContext);

    expect(result).toContain('Fix bug in `handler.ts` - check for **null** values');
  });
});

describe('Direct Template', () => {
  it('should contain all required sections', () => {
    // Test buildScoutPrompt with empty context to see the full template structure
    const mockTaskContext: TaskContext = {
      chatId: 'test',
      messageId: 'test',
      taskPath: '/test',
    };
    const result = buildScoutPrompt('', mockTaskContext);

    expect(result).toContain('## Task Context');
    expect(result).toContain('## User Request');
    expect(result).toContain('## Your Instruction');
  });

  it('should include workflow instructions', () => {
    const mockTaskContext: TaskContext = {
      chatId: 'test',
      messageId: 'test',
      taskPath: '/test',
    };
    const result = buildScoutPrompt('Test', mockTaskContext);

    expect(result).toContain('task initialization specialist');
    expect(result).toContain('Explore first');
    expect(result).toContain('Create Task.md');
  });
});
