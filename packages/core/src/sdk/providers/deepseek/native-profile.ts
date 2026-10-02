import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** An owned overlay; the installed DSH profile and user patch files stay authoritative. */
export function createDshNativeProfileOverlay(): { path: string; dispose(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'disclaude-dsh-native-'));
  const path = join(directory, 'cordis.patch.yml');
  const moduleUrl = new URL('./native-app.js', import.meta.url).href;
  writeFileSync(
    path,
    '- id: sdk-jsonrpc-server\n  disabled: true\n' +
      `- insert:\n    - id: disclaude-dsh-native-app\n      name: ${JSON.stringify(moduleUrl)}\n`,
    { mode: 0o600 }
  );
  return { path, dispose: () => rmSync(directory, { recursive: true }) };
}
