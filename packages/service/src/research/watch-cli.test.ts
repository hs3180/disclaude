/**
 * Tests for the `disclaude research watch` CLI client (T-089 rework / #5197).
 *
 * Argument parsing is pure; the REST transport is exercised through an
 * injected fetch so no socket is opened. The single-line JSON output contract
 * (`{"ok":true|false,...}` + actionable hints) is asserted line by line.
 */

import { describe, it, expect } from 'vitest';
import {
  parseResearchWatchArgs,
  runResearchWatchCommand,
  RESEARCH_WATCH_HELP,
  type ResearchWatchCliIo,
} from './watch-cli.js';

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function fakeIo(
  handler: (request: CapturedRequest) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
  env: NodeJS.ProcessEnv = {},
): { io: ResearchWatchCliIo; requests: CapturedRequest[]; lines: string[] } {
  const requests: CapturedRequest[] = [];
  const lines: string[] = [];
  const io: ResearchWatchCliIo = {
    env,
    write: line => { lines.push(line); },
    fetchImpl: (async (url, init) => {
      const request: CapturedRequest = { url: String(url), init };
      requests.push(request);
      const { status, body } = await handler(request);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  };
  return { io, requests, lines };
}

function jsonLine(line: string | undefined): Record<string, unknown> {
  expect(line).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

describe('parseResearchWatchArgs', () => {
  it('parses start with an interval and common flags', () => {
    const command = parseResearchWatchArgs(['watch', 'start', '--interval', '60', '--base-url', 'http://127.0.0.1:9', '--api-token', 't']);
    expect(command).toEqual({ kind: 'start', intervalSec: 60, baseUrl: 'http://127.0.0.1:9', apiToken: 't' });
  });

  it('parses bare start/stop/status', () => {
    expect(parseResearchWatchArgs(['watch', 'start'])).toEqual({ kind: 'start' });
    expect(parseResearchWatchArgs(['watch', 'stop'])).toEqual({ kind: 'stop' });
    expect(parseResearchWatchArgs(['watch', 'status'])).toEqual({ kind: 'status' });
  });

  it('parses add with doc/chat and optional fields', () => {
    expect(parseResearchWatchArgs(['watch', 'add', '--doc', 'doxcnA', '--chat', 'oc_c'])).toEqual({
      kind: 'add', docToken: 'doxcnA', chatId: 'oc_c',
    });
    expect(parseResearchWatchArgs(['watch', 'add', '--doc', 'doxcnA', '--chat', 'oc_c', '--type', 'docx', '--project', 'P', '--as', 'bot'])).toEqual({
      kind: 'add', docToken: 'doxcnA', chatId: 'oc_c', docType: 'docx', projectName: 'P', identity: 'bot',
    });
  });

  it('parses remove and help', () => {
    expect(parseResearchWatchArgs(['watch', 'remove', '--doc', 'doxcnA'])).toEqual({ kind: 'remove', docToken: 'doxcnA' });
    expect(parseResearchWatchArgs(['watch', '--help']).kind).toBe('help');
    expect(parseResearchWatchArgs(['--help']).kind).toBe('help');
  });

  it('rejects unknown subcommands, unknown flags, and missing values', () => {
    expect(() => parseResearchWatchArgs(['watch', 'pause'])).toThrow(/unknown subcommand/);
    expect(() => parseResearchWatchArgs(['listen'])).toThrow(/unexpected argument/);
    expect(() => parseResearchWatchArgs(['watch'])).toThrow(/missing subcommand/);
    expect(() => parseResearchWatchArgs(['watch', 'status', '--doc', 'x'])).toThrow(/Unknown option/);
    expect(() => parseResearchWatchArgs(['watch', 'add', '--doc'])).toThrow(/missing value/i);
    expect(() => parseResearchWatchArgs(['watch', 'add', '--chat', 'oc_c'])).toThrow(/requires --doc/);
    expect(() => parseResearchWatchArgs(['watch', 'add', '--doc', 'd'])).toThrow(/requires --chat/);
    expect(() => parseResearchWatchArgs(['watch', 'add', '--doc', 'd', '--chat', 'c', '--as', 'app'])).toThrow(/user or bot/);
    expect(() => parseResearchWatchArgs(['watch', 'start', '--interval', '0'])).toThrow(/positive number/);
    expect(() => parseResearchWatchArgs([])).toThrow(/missing subcommand/);
    expect(() => parseResearchWatchArgs(['watch', 'start', 'extra'])).toThrow(/unexpected positional/);
  });
});

describe('runResearchWatchCommand', () => {
  it('help prints usage and exits 0 without any transport', async () => {
    const { io, requests, lines } = fakeIo(() => ({ status: 200, body: { ok: true } }));
    const code = await runResearchWatchCommand({ kind: 'help' }, io);
    expect(code).toBe(0);
    expect(requests).toEqual([]);
    expect(lines).toEqual([`${RESEARCH_WATCH_HELP}\n`]);
  });

  it('start POSTs intervalSec with the bearer token and forwards the payload', async () => {
    const { io, requests, lines } = fakeIo(
      () => ({ status: 200, body: { ok: true, started: true, watch: { running: true } } }),
      { DISCLAUDE_API_BASE_URL: 'http://127.0.0.1:9123/', DISCLAUDE_API_TOKEN: 'sekret' },
    );
    const code = await runResearchWatchCommand({ kind: 'start', intervalSec: 300 }, io);
    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('http://127.0.0.1:9123/api/research/watch/start');
    expect(requests[0].init?.method).toBe('POST');
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ intervalSec: 300 });
    expect((requests[0].init?.headers as Record<string, string>).authorization).toBe('Bearer sekret');
    expect(jsonLine(lines[0])).toEqual({ ok: true, started: true, watch: { running: true } });
  });

  it('status GETs without a body and without inventing a token', async () => {
    const { io, requests, lines } = fakeIo(
      () => ({ status: 200, body: { ok: true, watch: { running: false, registrations: [] } } }),
      { DISCLAUDE_API_BASE_URL: 'http://127.0.0.1:7' },
    );
    const code = await runResearchWatchCommand({ kind: 'status' }, io);
    expect(code).toBe(0);
    expect(requests[0].url).toBe('http://127.0.0.1:7/api/research/watch/status');
    expect(requests[0].init?.method).toBe('GET');
    expect(requests[0].init?.body).toBeUndefined();
    expect((requests[0].init?.headers as Record<string, string>).authorization).toBeUndefined();
    expect(jsonLine(lines[0]).watch).toEqual({ running: false, registrations: [] });
  });

  it('add posts the registration association', async () => {
    const { io, requests, lines } = fakeIo(
      () => ({ status: 200, body: { ok: true, registration: { docToken: 'doxcnA' } } }),
      { DISCLAUDE_API_BASE_URL: 'http://127.0.0.1:7' },
    );
    const code = await runResearchWatchCommand({ kind: 'add', docToken: 'doxcnA', chatId: 'oc_c', projectName: 'P' }, io);
    expect(code).toBe(0);
    expect(requests[0].url).toBe('http://127.0.0.1:7/api/research/watch/register');
    expect(JSON.parse(String(requests[0].init?.body))).toEqual({ docToken: 'doxcnA', chatId: 'oc_c', projectName: 'P' });
    expect(jsonLine(lines[0]).registration).toEqual({ docToken: 'doxcnA' });
  });

  it('maps 401 to a token hint and 400 to the server message', async () => {
    const unauthorized = fakeIo(() => ({ status: 401, body: { ok: false, message: 'Invalid or missing API token' } }), { DISCLAUDE_API_BASE_URL: 'http://127.0.0.1:7' });
    expect(await runResearchWatchCommand({ kind: 'start' }, unauthorized.io)).toBe(1);
    const failure = jsonLine(unauthorized.lines[0]);
    expect(failure.ok).toBe(false);
    expect(failure.command).toBe('research watch start');
    expect(String(failure.hint)).toContain('DISCLAUDE_API_TOKEN');

    const refused = fakeIo(() => ({ status: 400, body: { ok: false, message: '登记项无效:docToken/chatId/identity/registeredAt 必须符合约束' } }), { DISCLAUDE_API_BASE_URL: 'http://127.0.0.1:7' });
    expect(await runResearchWatchCommand({ kind: 'add', docToken: 'bad', chatId: 'oc_c' }, refused.io)).toBe(1);
    expect(jsonLine(refused.lines[0]).error).toContain('登记项无效');
  });

  it('reports an unreachable service with an actionable hint', async () => {
    const { io, lines } = fakeIo(() => { throw new TypeError('fetch failed'); }, { DISCLAUDE_API_BASE_URL: 'http://127.0.0.1:7' });
    expect(await runResearchWatchCommand({ kind: 'stop' }, io)).toBe(1);
    const failure = jsonLine(lines[0]);
    expect(failure.ok).toBe(false);
    expect(String(failure.error)).toContain('cannot reach the disclaude service');
    expect(String(failure.hint)).toContain('DISCLAUDE_API_BASE_URL');
  });

  it('fails fast when no service address is configured', async () => {
    const { io, requests, lines } = fakeIo(() => ({ status: 200, body: { ok: true } }), {});
    expect(await runResearchWatchCommand({ kind: 'status' }, io)).toBe(1);
    expect(requests).toEqual([]);
    const failure = jsonLine(lines[0]);
    expect(String(failure.hint)).toContain('--base-url');
  });

  it('fails on a non-JSON response', async () => {
    const lines: string[] = [];
    const io: ResearchWatchCliIo = {
      env: { DISCLAUDE_API_BASE_URL: 'http://127.0.0.1:7' },
      write: line => { lines.push(line); },
      fetchImpl: (() => Promise.resolve(new Response('<html>gateway</html>', { status: 502 }))) as typeof fetch,
    };
    expect(await runResearchWatchCommand({ kind: 'status' }, io)).toBe(1);
    expect(String(jsonLine(lines[0]).error)).toContain('HTTP 502');
  });
});
