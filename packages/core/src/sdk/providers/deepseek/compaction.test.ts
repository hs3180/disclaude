import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DSH_CONTEXT_WINDOW, resolveDshCompaction } from './compaction.js';

afterEach(() => vi.unstubAllGlobals());
const api = { protocol: 'openai' as const, baseUrl: 'https://selected.example/v1', model: 'selected-model' };
const signal = () => new AbortController().signal;

describe('DSH native compaction budget', () => {
  it('uses the explicit trigger before metadata and permits an explicit opt-out', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const settings = await resolveDshCompaction(api, 'selected-key', 48_000, signal());
    expect(settings.source).toBe('configured');
    expect(settings.contextWindow! * settings.thresholdRatio).toBe(48_000);
    expect(await resolveDshCompaction(api, 'selected-key', 0, signal())).toMatchObject({ auto: false, source: 'disabled' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['openai', 'anthropic'] as const)('uses only the selected %s route and model capacity', async protocol => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(Response.json({ data: [
        { id: 'other-model', context_length: 999999 },
        { id: api.model, context_length: 262144, max_tokens: 4096 },
      ] }));
    vi.stubGlobal('fetch', fetcher);
    const selected = { ...api, protocol, baseUrl: `https://selected.example/v1${protocol === 'anthropic' ? '/anthropic' : ''}` };
    expect(await resolveDshCompaction(selected, 'selected-key', 'auto', signal())).toMatchObject({
      source: 'model-api', contextWindow: 262144, thresholdRatio: 0.8,
    });
    for (const [url, options] of fetcher.mock.calls) {
      expect(url.origin).toBe('https://selected.example');
      expect(url.pathname).toMatch(/^\/v1\/models/);
      expect(options.redirect).toBe('error');
      expect(options.headers.authorization).toBe('Bearer selected-key');
    }
  });

  it('warns and uses the conservative fallback when only output max_tokens is published', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(Response.json({ id: api.model, max_tokens: 8192 }))));
    expect(await resolveDshCompaction(api, 'selected-key', undefined, signal())).toMatchObject({
      contextWindow: DEFAULT_DSH_CONTEXT_WINDOW, source: 'fallback', auto: true,
    });
  });

  it('does not retry unauthorized metadata through another path or send credentials to redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    expect((await resolveDshCompaction(api, 'selected-key', undefined, signal())).source).toBe('fallback');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  });

  it('preserves cancellation during discovery rather than starting with a fallback', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')));
    })));
    const pending = resolveDshCompaction(api, 'selected-key', undefined, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('leaves low-level native route policies native and refuses an unsupported absolute override', async () => {
    expect((await resolveDshCompaction(undefined, undefined, undefined, signal())).source).toBe('native-profile');
    await expect(resolveDshCompaction(undefined, undefined, 1000, signal())).rejects.toThrow('llms.api');
  });
});
