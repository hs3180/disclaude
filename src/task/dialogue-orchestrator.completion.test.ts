/**
 * Tests for task completion messages in DialogueOrchestrator
 */

import { describe, it, expect } from 'vitest';
import { DialogueOrchestrator } from './dialogue-orchestrator.js';

describe('DialogueOrchestrator - Task Completion Messages', () => {
  // Helper method to test private method via type assertion
  const getCompletionMessage = (
    orchestrator: DialogueOrchestrator,
    iteration: number,
    completionType: 'full' | 'design_only'
  ) => {
    return (orchestrator as any).buildTaskCompletionMessage.call(
      orchestrator,
      iteration,
      completionType
    );
  };

  const getWarningMessage = (orchestrator: DialogueOrchestrator, iteration: number) => {
    return (orchestrator as any).buildMaxIterationsWarning.call(orchestrator, iteration);
  };

  describe('buildTaskCompletionMessage', () => {
    it('should generate "full" completion message', () => {
      const orchestrator = new DialogueOrchestrator({
        managerConfig: {
          apiKey: 'test-key',
          model: 'test-model',
        },
        workerConfig: {
          apiKey: 'test-key',
          model: 'test-model',
        },
      });

      // Set taskId
      (orchestrator as any).taskId = 'test-task-123';

      const message = getCompletionMessage(orchestrator, 2, 'full');

      expect(message).toBeDefined();
      expect(message.messageType).toBe('task_completion');
      expect(message.content).toContain('✅ **任务完成**');
      expect(message.content).toContain('`test-task-123`');
      expect(message.content).toContain('完成迭代**: 2');
      expect(message.content).toContain('✨ **执行状态**: 代码已实现并验证完成');
    });

    it('should generate "design_only" completion message', () => {
      const orchestrator = new DialogueOrchestrator({
        managerConfig: {
          apiKey: 'test-key',
          model: 'test-model',
        },
        workerConfig: {
          apiKey: 'test-key',
          model: 'test-model',
        },
      });

      // Set taskId
      (orchestrator as any).taskId = 'design-task-456';

      const message = getCompletionMessage(orchestrator, 1, 'design_only');

      expect(message).toBeDefined();
      expect(message.messageType).toBe('task_completion');
      expect(message.content).toContain('✅ **任务完成（设计方案）**');
      expect(message.content).toContain('`design-task-456`');
      expect(message.content).toContain('完成迭代**: 1');
      expect(message.content).toContain('📋 **已完成**');
      expect(message.content).toContain('⚠️ **注意**');
      expect(message.content).toContain('代码尚未实现');
      expect(message.content).toContain('请参考上述指令手动完成实现');
    });
  });

  describe('buildMaxIterationsWarning', () => {
    it('should generate max iterations warning message', () => {
      const orchestrator = new DialogueOrchestrator({
        managerConfig: {
          apiKey: 'test-key',
          model: 'test-model',
        },
        workerConfig: {
          apiKey: 'test-key',
          model: 'test-model',
        },
      });

      // Set taskId
      (orchestrator as any).taskId = 'incomplete-task-789';

      const message = getWarningMessage(orchestrator, 3);

      expect(message).toBeDefined();
      expect(message.messageType).toBe('max_iterations_warning');
      expect(message.content).toContain('⚠️ **达到最大迭代次数**');
      expect(message.content).toContain('已完成 3 次迭代');
      expect(message.content).toContain('`incomplete-task-789`');
      expect(message.content).toContain('**建议**');
      expect(message.content).toContain('使用 /reset 重置对话');
    });
  });

  describe('Message content quality', () => {
    it('should include helpful next steps for design_only completion', () => {
      const orchestrator = new DialogueOrchestrator({
        managerConfig: {
          apiKey: 'test-key',
          model: 'test-model',
        },
        workerConfig: {
          apiKey: 'test-key',
          model: 'test-model',
        },
      });

      (orchestrator as any).taskId = 'task-abc';
      const message = getCompletionMessage(orchestrator, 1, 'design_only');

      expect(message.content).toContain('💡');
      expect(message.content).toContain('🧪');
      expect(message.content).toContain('测试验证');
    });

    it('should be concise for full completion', () => {
      const orchestrator = new DialogueOrchestrator({
        managerConfig: {
          apiKey: 'test-key',
          model: 'test-model',
        },
        workerConfig: {
          apiKey: 'test-key',
          model: 'test-model',
        },
      });

      (orchestrator as any).taskId = 'task-xyz';
      const message = getCompletionMessage(orchestrator, 3, 'full');

      // Full completion should be shorter and more positive
      expect(message.content.length).toBeLessThan(200);
      expect(message.content).toContain('✨');
    });
  });
});
