import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatalayerJupyterClient } from './datalayer-client.js';
import { jupyterDiagnostic, jupyterExitCode, jupyterNetworkDiagnostic, jupyterServerBody } from './diagnostics.js';

afterEach(() => vi.unstubAllGlobals());
const secret = 'owned-private-token/with"quotes';
const connection = () => new DatalayerJupyterClient({ baseUrl: 'https://owned.invalid/', authorization: () => Promise.resolve(`token ${secret}`) });

describe('public Jupyter failure layers', () => {
  it.each([['ENOTFOUND', 'dns', 4], ['ECONNREFUSED', 'tcp', 5], ['ECONNRESET', 'tcp', 5]])('classifies %s by code without reflecting the raw exception', (code, layer, exit) => {
    const error = jupyterNetworkDiagnostic(new TypeError(`private Authorization: ${secret}`, { cause: { code } }));
    expect(error.diagnostic.layer).toBe(layer);
    expect(jupyterExitCode(error.diagnostic.layer)).toBe(exit);
    expect(JSON.stringify(error.diagnostic)).not.toContain(secret);
    expect(error.diagnostic.outcome).toBe('unknown');
  });
  it('retains HTTP status and a useful scrubbed server message without retrying a mutation', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ message: `Parent directory missing; ${secret}`,
      traceback: `private trace ${secret}`, token: secret }), { status: 404 })));
    vi.stubGlobal('fetch', fetch);
    let failed: unknown;
    try { await connection().json('api/contents/research/missing.ipynb', 'PUT', {}); }
    catch (error) { failed = error; }
    const diagnostic = jupyterDiagnostic(failed);
    expect(diagnostic).toMatchObject({ layer: 'http', status: 404, outcome: 'unknown' });
    expect(diagnostic.serverBody).toContain('Parent directory missing');
    expect(diagnostic.serverBody).toContain('[redacted]');
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(diagnostic.serverBody).not.toContain('private trace');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('labels a rejected credential separately from HTTP/schema and stops check at the first failing hop', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ message: `Denied ${secret}` }), { status: 401 })));
    vi.stubGlobal('fetch', fetch);
    await expect(connection().inspectConnection()).rejects.toMatchObject({ diagnostic: { layer: 'auth', status: 401, code: 'authentication_rejected' } });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('scrubs a password even when authentication fails before a login submission', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ message: `Unavailable ${secret}` }), { status: 503 }))));
    const client = new DatalayerJupyterClient({ baseUrl: 'https://owned.invalid/', password: () => Promise.resolve(secret) });
    let failed: unknown;
    try { await client.inspectConnection(); } catch (error) { failed = error; }
    const diagnostic = jupyterDiagnostic(failed);
    expect(diagnostic).toMatchObject({ layer: 'http', status: 503, phase: 'authentication-check' });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
  });
  it('keeps invalid JSON response text and local filesystem exceptions private', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(`not JSON ${secret}`))));
    await expect(connection().json('api')).rejects.toMatchObject({ diagnostic: { layer: 'schema', code: 'invalid_json_response', status: 200 } });
    const local = jupyterDiagnostic(Object.assign(new Error(`/private/${secret}`), { code: 'EACCES' }));
    expect(local.layer).toBe('local'); expect(JSON.stringify(local)).not.toContain(secret);
  });
  it('omits HTML and private structured fields; redacts URL queries and known encoded values', () => {
    expect(jupyterServerBody(`<form password="${secret}">`, [secret])).toBe('[HTML response omitted]');
    const body = jupyterServerBody(JSON.stringify({ error: { message: `Failed ${encodeURIComponent(secret)} at https://user:password@owned.invalid/api?token=private` }, cookie: secret }), [secret]);
    expect(body).toContain('[redacted]'); expect(body).not.toContain('private'); expect(body).not.toContain('user:password');
  });
});
