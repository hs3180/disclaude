import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJupyterSharedNotebookCell } from './rtc-notebook-reader.js';

describe('readJupyterSharedNotebookCell', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects invalid paths before making a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      readJupyterSharedNotebookCell(
        { serverUrl: 'https://jupyter.example/', authorization: 'token test-token' },
        '../private.ipynb',
        'cell-1'
      )
    ).rejects.toThrow('relative .ipynb path');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects credentials or token query parameters in the server URL', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      readJupyterSharedNotebookCell(
        { serverUrl: 'https://user:password@jupyter.example/', authorization: 'token test-token' },
        'analysis.ipynb',
        'cell-1'
      )
    ).rejects.toThrow('must not contain credentials');
    await expect(
      readJupyterSharedNotebookCell(
        { serverUrl: 'https://jupyter.example/?token=secret', authorization: 'token test-token' },
        'analysis.ipynb',
        'cell-1'
      )
    ).rejects.toThrow('must not contain credentials');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires HTTPS for authenticated non-loopback servers', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      readJupyterSharedNotebookCell(
        { serverUrl: 'http://jupyter.example/', authorization: 'token test-token' },
        'analysis.ipynb',
        'cell-1'
      )
    ).rejects.toThrow('requires HTTPS');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed authorization headers and cell identifiers', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      readJupyterSharedNotebookCell(
        { serverUrl: 'https://jupyter.example/', authorization: 'token test-token\nX-Leak: value' },
        'analysis.ipynb',
        'cell-1'
      )
    ).rejects.toThrow('authorization header');
    await expect(
      readJupyterSharedNotebookCell(
        { serverUrl: 'https://jupyter.example/', authorization: 'token test-token' },
        'analysis.ipynb',
        ''
      )
    ).rejects.toThrow('cellId is required');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid timeouts before making a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      readJupyterSharedNotebookCell(
        {
          serverUrl: 'https://jupyter.example/',
          authorization: 'token test-token',
          timeoutMs: 120_001,
        },
        'analysis.ipynb',
        'cell-1'
      )
    ).rejects.toThrow('timeoutMs');

    expect(fetch).not.toHaveBeenCalled();
  });
});
