import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduleDiagnostic } from '@disclaude/core';
import {
  createScheduleDiagnosticReporter,
  type ScheduleDiagnosticReporterOptions,
} from './schedule-diagnostic-reporter.js';

describe('createScheduleDiagnosticReporter', () => {
  const sendMessage = vi.fn<ScheduleDiagnosticReporterOptions['sendMessage']>();
  const onDeliveryFailure = vi.fn<(taskId: string, code?: string) => void>();
  let report: (diagnostic: ScheduleDiagnostic) => void;
  const diagnostic: ScheduleDiagnostic = {
    action: 'report',
    filePath: '/workspace/schedules/daily/SCHEDULE.md',
    taskId: 'schedule-daily',
    chatId: 'oc_owner123',
    code: 'invalid-frontmatter',
    severity: 'error',
    message: 'Frontmatter is invalid near line 3.',
  };

  beforeEach(() => {
    sendMessage.mockReset().mockResolvedValue({ success: true });
    onDeliveryFailure.mockReset();
    report = createScheduleDiagnosticReporter({ sendMessage, onDeliveryFailure });
  });

  it('notifies the task chat once per diagnostic and omits the local file path', () => {
    report(diagnostic);
    report(diagnostic);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'oc_owner123',
      expect.stringContaining('定时任务 schedule-daily 未能加载')
    );
    expect(sendMessage.mock.calls[0]?.[1]).toContain('Frontmatter is invalid near line 3.');
    expect(sendMessage.mock.calls[0]?.[1]).not.toContain('/workspace/');
  });

  it('notifies a newly configured task chat and clears the duplicate after recovery', () => {
    report(diagnostic);
    report({ ...diagnostic, chatId: 'oc_newowner123' });
    report({ ...diagnostic, action: 'clear' });
    report(diagnostic);

    expect(sendMessage.mock.calls.map(([chatId]) => chatId)).toEqual([
      'oc_owner123',
      'oc_newowner123',
      'oc_owner123',
    ]);
  });

  it('reports a severity change even when the code, message and chat stay the same', () => {
    report(diagnostic);
    report({ ...diagnostic, severity: 'warning' });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]?.[1]).toContain('配置警告');
  });

  it('does not send when the diagnostic cannot identify a task chat', () => {
    report({ ...diagnostic, chatId: undefined });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('records delivery failure without rejecting the diagnostic callback', async () => {
    sendMessage.mockRejectedValue(new Error('sensitive transport details'));

    expect(() => report(diagnostic)).not.toThrow();
    await vi.waitFor(() =>
      expect(onDeliveryFailure).toHaveBeenCalledWith('schedule-daily', 'invalid-frontmatter')
    );
  });
});
