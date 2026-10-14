import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The SDK serializes inline settings into argv; keep API keys in a private file. */
export function privateSdkSettings(options: Record<string, unknown>): {
  options: Record<string, unknown>; cleanup: () => void;
} {
  const settings = options.settings as { env?: Record<string, string> } | undefined;
  if (!settings?.env?.ANTHROPIC_API_KEY) {
    return { options, cleanup: () => {} };
  }
  const directory = mkdtempSync(join(tmpdir(), 'disclaude-claude-settings-'));
  const file = join(directory, 'settings.json');
  const cleanup = (): void => { rmSync(directory, { recursive: true, force: true }); };
  try {
    chmodSync(directory, 0o700);
    writeFileSync(file, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
    return { options: { ...options, settings: file }, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
