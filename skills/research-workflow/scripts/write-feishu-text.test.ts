import { describe, expect, it, vi } from 'vitest';
import { writeArguments, writeFeishuText } from './write-feishu-text.mjs';

describe('literal Feishu document writes', () => {
  it('passes Unicode, backticks, command substitutions and actual newlines as one literal argument', async () => {
    const content = '**范围**：`ß`/`ss`\n\n$(touch SHOULD_NOT_EXIST) "quote" \\path';
    const pattern = '`old`\n\n$HOME';
    const run = vi.fn().mockResolvedValue({ stdout: '{"ok":true}' });
    await expect(writeFeishuText({ documentId: 'doc', identity: 'bot', command: 'str_replace', content, pattern, revision: '32' }, run)).resolves.toEqual({ ok: true });
    const [binary, args, options] = run.mock.calls[0];
    expect(binary).toBe('lark-cli');
    expect(args[args.indexOf('--content') + 1]).toBe(content);
    expect(args[args.indexOf('--pattern') + 1]).toBe(pattern);
    expect(args).toEqual(expect.arrayContaining(['--revision-id', '32']));
    expect(options).not.toHaveProperty('shell');
  });

  it('does not retry an unknown write result', async () => {
    const run = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(writeFeishuText({ documentId: 'doc', identity: 'user', command: 'append', content: 'text' }, run)).rejects.toThrow('timeout');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects broad replacements, missing identity and invalid revision before executing', () => {
    const input = { documentId: 'doc', identity: 'user', command: 'str_replace', content: 'text' };
    expect(() => writeArguments(input)).toThrow('replacement_pattern_required');
    expect(() => writeArguments({ ...input, command: 'overwrite' })).toThrow('invalid_write_input');
    expect(() => writeArguments({ ...input, identity: undefined })).toThrow('invalid_write_input');
    expect(() => writeArguments({ ...input, command: 'append', revision: 'unknown' })).toThrow('invalid_revision');
  });
});
