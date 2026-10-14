import { describe, expect, it } from 'vitest';
import { DshTaskProgress } from './dsh-task-progress.js';

describe('DSH provider public task progress', () => {
  it('keeps the public choice and reason concise', () => {
    expect(new DshTaskProgress().next('先读取现有配置，\n避免覆盖用户的修改。', 'Read')).toBe('⏳ 先读取现有配置， 避免覆盖用户的修改。');
  });

  it.each(['', '🤔 Thinking...', '```bash cat /private/file```', '{"key":"private"}'])('uses a safe stage instead of a placeholder or payload: %s', summary => {
    expect(new DshTaskProgress().next(summary, 'Bash')).toBe('⏳ 正在执行命令。');
  });

  it('coalesces rapid and repeated updates, caps each turn, and resets for the next request', () => {
    let at = 0;
    const progress = new DshTaskProgress(() => at);
    expect(progress.next('阶段一', 'Read')).toBeDefined();
    at = 1000;
    expect(progress.next('阶段二', 'Read')).toBeUndefined();
    at = 20_000;
    expect(progress.next(' 阶段一。 ', 'Read')).toBeUndefined();
    for (const stage of ['二', '三', '四']) {
      at += 20_000;
      expect(progress.next(`阶段${stage}`, 'Read')).toBeDefined();
    }
    at += 20_000;
    expect(progress.next('阶段五', 'Read')).toBeUndefined();
    progress.reset();
    expect(progress.next('阶段一', 'Read')).toBeDefined();
  });
});
