import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerTransport } from './app-server-transport.js';

const dirs: string[] = [];

function fixture(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-app-server-'));
  dirs.push(dir);
  const binary = join(dir, 'codex');
  writeFileSync(binary, `#!/bin/sh\n${body}`);
  chmodSync(binary, 0o755);
  return binary;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('CodexAppServerTransport', () => {
  it('initializes, correlates responses, and forwards notifications', async () => {
    const binary = fixture(`
read initialize
id=$(printf '%s' "$initialize" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
printf '{"jsonrpc":"2.0","id":%s,"result":{"serverInfo":{"name":"fixture"}}}\\n' "$id"
read initialized
printf '{"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"t-1"}}}\\n'
read request
id=$(printf '%s' "$request" | sed -n 's/.*"id":\\([0-9]*\\).*/\\1/p')
printf '{"jsonrpc":"2.0","id":%s,"result":{"turnId":"turn-1"}}\\n' "$id"
`);
    const onNotification = vi.fn();
    const transport = new CodexAppServerTransport({ binary, onNotification });
    try {
      await expect(transport.initialize()).resolves.toMatchObject({ serverInfo: { name: 'fixture' } });
      await expect(transport.request('turn/start', { threadId: 't-1', input: [] }))
        .resolves.toEqual({ turnId: 'turn-1' });
      await vi.waitFor(() => expect(onNotification).toHaveBeenCalledWith(
        'thread/started', { thread: { id: 't-1' } }
      ));
    } finally {
      transport.close();
    }
  });

  it('rejects pending requests when the process exits', async () => {
    const transport = new CodexAppServerTransport({ binary: fixture('read line\nexit 7') });
    await expect(transport.request('thread/start', {})).rejects.toThrow(/exited.*code=7/);
  });

  it('fails closed for server approval/tool requests', async () => {
    const binary = fixture(`
read request
printf '{"jsonrpc":"2.0","id":99,"method":"item/commandExecution/requestApproval","params":{}}\\n'
read response
printf '%s' "$response" > "$(dirname "$0")/response"
`);
    const transport = new CodexAppServerTransport({ binary });
    await expect(transport.request('will-remain-pending')).rejects.toThrow(/code=0/);
    expect(JSON.parse(readFileSync(join(dirname(binary), 'response'), 'utf8'))).toMatchObject({
      id: 99,
      error: { code: -32601 },
    });
  });
});
