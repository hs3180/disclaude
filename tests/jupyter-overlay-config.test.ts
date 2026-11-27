/**
 * #5750 — jupyter/datalayer overlay RTC policy drift guard.
 *
 * `document_cleanup_delay: null` kept YDoc rooms alive forever, so a failed or
 * deferred text-file save left the in-memory room permanently newer than the
 * disk: Lab showed the edited .py while kernels and terminals kept executing
 * the stale disk bytes, and only a Jupyter restart re-converged them (upstream
 * jupyter-collaboration #219/#535). The repair restores the upstream default
 * 60-second idle destroy, whose final flush is the only self-heal available
 * on that upstream path. These guards keep the overlay from silently
 * regressing to the unfixed policy; they do not modify upstream packages.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const policyUrl = new URL('../jupyter/datalayer/server-config.json', import.meta.url);

describe('jupyter datalayer overlay RTC policy', () => {
  it('destroys idle YDoc rooms after 60s so the final flush reaches disk', async () => {
    const policy = JSON.parse(await readFile(fileURLToPath(policyUrl), 'utf8')) as {
      YDocExtension?: { document_cleanup_delay?: unknown };
    };
    // `null` disables room destruction entirely — the exact regression #5750
    // fixed; a missing value would fall back to the upstream default instead
    // of the pinned overlay intent, so both are guarded here.
    expect(policy.YDocExtension?.document_cleanup_delay).toBe(60);
  });

  it('keeps the debounced room save enabled', async () => {
    const policy = JSON.parse(await readFile(fileURLToPath(policyUrl), 'utf8')) as {
      YDocExtension?: { document_save_delay?: unknown };
    };
    expect(policy.YDocExtension?.document_save_delay).toBe(1);
  });
});
