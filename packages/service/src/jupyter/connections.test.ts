import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JupyterConnections } from './connections.js';

let root: string;
const servers: Server[] = [];
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'notebook-connections-'));
});
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  nock.disableNetConnect();
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const seen: Array<{ cookie?: string; authorization?: string }> = [];
  let requests = 0;
  const server = createServer((request, response) => {
    seen.push({ cookie: request.headers.cookie, authorization: request.headers.authorization });
    requests++;
    if (!request.headers.cookie) {
      response.setHeader('Set-Cookie', 'owned-session=principal-1; HttpOnly; Path=/');
    }
    response.end(
      JSON.stringify({
        protocolVersion: 1,
        serverNamespace: 'namespace',
        stack: {},
        activeRooms: 0,
        pendingRooms: 0,
        roomFailures: {},
        maxRooms: 16,
        idleSeconds: 60,
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  nock.enableNetConnect((authority) => authority === new URL(baseUrl).host);
  const config = join(root, 'connections.json');
  const auth = join(root, 'auth');
  fs.writeFileSync(auth, 'token private-auth', { mode: 0o600 });
  fs.writeFileSync(
    config,
    JSON.stringify({ version: 1, connections: [{ id: 'host', baseUrl, authorizationFile: auth }] }),
    { mode: 0o600 }
  );
  return { config, auth, seen, requests: () => requests };
}

describe('JupyterConnections', () => {
  it('persists a private host cookie identity across service connection instances', async () => {
    const f = await fixture();
    const first = new JupyterConnections(f.config, () => ({}));
    await Promise.all([
      first.use('host', 'namespace', () => Promise.resolve(true)),
      first.use('host', 'namespace', () => Promise.resolve(true)),
    ]);
    expect(f.requests()).toBe(1);
    await new JupyterConnections(f.config, () => ({})).use('host', 'namespace', () =>
      Promise.resolve(true)
    );
    expect(f.seen[1].cookie).toBe('owned-session=principal-1');
    expect(f.seen.every((request) => request.authorization === 'token private-auth')).toBe(true);
    const files = fs.readdirSync(join(root, 'sessions'));
    expect(files).toHaveLength(1);
    expect(fs.statSync(join(root, 'sessions', files[0])).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(f.config, 'utf8')).not.toContain('private-auth');
  });

  it('refuses a different server namespace and public authentication files', async () => {
    const f = await fixture();
    await expect(
      new JupyterConnections(f.config, () => ({})).use('host', 'other', () => Promise.resolve(true))
    ).rejects.toThrow('namespace');
    fs.chmodSync(f.auth, 0o644);
    await expect(
      new JupyterConnections(f.config, () => ({})).use('host', 'namespace', () =>
        Promise.resolve(true)
      )
    ).rejects.toThrow('authentication');
  });

  it('strips configured authorization environment variables from model processes', () => {
    const config = join(root, 'connections.json');
    fs.writeFileSync(
      config,
      JSON.stringify({
        version: 1,
        connections: [
          { id: 'host', baseUrl: 'https://example.test', authorizationEnv: 'OWNED_AUTH' },
        ],
      }),
      { mode: 0o600 }
    );
    const environment: Record<string, string | undefined> = {
      OWNED_AUTH: 'token private-auth',
      PATH: '/bin',
    };
    new JupyterConnections(config, () => environment).redactEnvironment(environment);
    expect(environment).toEqual({ OWNED_AUTH: undefined, PATH: '/bin' });
  });
});
