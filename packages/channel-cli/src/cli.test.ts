import { describe, expect, it } from 'vitest';
import { HELP, run } from './cli.js';

describe('@disclaude/channel-cli', () => {
  it('exposes the packaged command surface in help', () => {
    expect(HELP).toContain('send_interactive');
    expect(HELP).toContain('disclaude-channel');
  });

  it('keeps argument failures to one JSON result', async () => {
    const writes: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      expect(await run(['send_text'])).toBe(1);
    } finally {
      process.stdout.write = original;
    }
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0])).toMatchObject({ ok: false, command: 'send_text' });
  });
});
