import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type DshBootstrap = 'cli' | 'node-sdk';

export function resolveDshBootstrap(value?: string): DshBootstrap {
  if (value === undefined || value === 'cli') { return 'cli'; }
  if (value === 'node-sdk') { return value; }
  throw new Error('DISCLAUDE_DSH_BOOTSTRAP must be cli or node-sdk');
}

/** Resolve only declared, pinned libraries; no CLI lookup or profile creation. */
export function dshSdkModules(): { boot: string; bundle: string; moduleBase: string; attachments: string } {
  for (const library of ['dsh-app-boot', 'dsh-sdk-minimal', 'dsh-attachment-local']) {
    const manifestPath = import.meta.resolve(`@deepseek-ai/${library}/package.json`);
    const manifest = JSON.parse(readFileSync(fileURLToPath(manifestPath), 'utf8')) as { version: string };
    if (manifest.version !== '0.1.2-rc.1') {
      throw new Error(`DSH Node SDK prototype requires pinned ${library}0.1.2-rc.1`);
    }
  }
  const boot = import.meta.resolve('@deepseek-ai/dsh-app-boot');
  const bundle = import.meta.resolve('@deepseek-ai/dsh-sdk-minimal/cordis.patch.yml');
  const moduleBase = import.meta.resolve('@deepseek-ai/dsh-sdk-minimal/package.json');
  if (!existsSync(fileURLToPath(bundle))) {
    throw new Error('DSH Node SDK prototype requires the pinned sdk-minimal bundle');
  }
  const attachments = import.meta.resolve('@deepseek-ai/dsh-attachment-local');
  return { boot, bundle, moduleBase, attachments };
}
