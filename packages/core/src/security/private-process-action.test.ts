import { describe, expect, it } from 'vitest';
import { ActionBoundInput } from './action-bound-input.js';
import { createPrivateProcessAction } from './private-process-action.js';

function operation(script: string, timeoutMs = 1000) {
  return createPrivateProcessAction({ id: 'installed-check', title: 'Check', description: 'Harness consumer',
    command: process.execPath, args: ['-e', script], env: {}, timeoutMs });
}

const context = { action: 'test', actor: 'actor', chat: 'chat', source: 'source', correlationId: 'trace' };

describe('private process consumer', () => {
  it('delivers bound input only to stdin and suppresses consumer stdout/stderr', async () => {
    const consumer = operation(`let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
      process.stdout.write(input);process.stderr.write(input);
      process.exitCode=require('node:crypto').createHash('sha256').update(input).digest('hex')==='84af7eaa6624ab928e5ecc6d42b0e8ee282a39c3bb3c51c04917949daedf1b36'&&!process.argv.concat(process.execArgv).join().includes(input)&&!JSON.stringify(process.env).includes(input)&&JSON.parse(process.env.DISCLAUDE_PRIVATE_CONTEXT).actor==='actor'?0:1;
    });`);
    const audit: unknown[] = [];
    const handoff = new ActionBoundInput(consumer, event => audit.push(event));
    const issued = handoff.issue('installed-check', 'actor', 'chat', 'source');
    handoff.bindCard(issued.nonce, 'card');
    const result = await handoff.submit({ ...issued.value, nonce: issued.nonce, action: 'installed-check',
      actor: 'actor', chat: 'chat', source: 'source', card: 'card', value: 'opaque-private-value' });
    expect(result).toBe('succeeded');
    expect(JSON.stringify({ result, audit })).not.toContain('opaque-private-value');
  });
  it('bounds stalled consumers and returns only fixed failure outcomes', async () => {
    expect(await operation('setInterval(()=>{},1000)', 50).consume('private', context)).toBe('failed');
    expect(await operation('process.exit(1)').consume('private', context)).toBe('failed');
    const missing = createPrivateProcessAction({ id: 'missing', title: 'Missing', description: 'Test', command: '/nonexistent/private-consumer' });
    expect(await missing.consume('private', context)).toBe('failed');
  });
});
