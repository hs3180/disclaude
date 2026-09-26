import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

describe('single service public contract', () => {
  it('exports only the unified executable and service workspace', () => {
    const root = JSON.parse(readFileSync('package.json', 'utf8'));
    const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
    const service = JSON.parse(readFileSync('packages/service/package.json', 'utf8'));
    expect(Object.keys(root.bin)).toEqual(['disclaude']);
    expect(root.dependencies['@disclaude/service']).toBeDefined();
    expect(service.bin).toBeUndefined();
    expect(root.dependencies['@disclaude/primary-node']).toBeUndefined();
    expect(lock.packages['packages/primary-node']).toBeUndefined();
    expect(lock.packages['packages/worker-node']).toBeUndefined();
    expect(existsSync('packages/primary-node')).toBe(false);
    expect(existsSync('packages/worker-node')).toBe(false);
    expect(existsSync('bin/disclaude-primary.js')).toBe(false);
    expect(existsSync('packages/core/src/types/primary-node.ts')).toBe(false);
  });
  it('does not retain node role capability/config exports', () => {
    for (const file of ['packages/core/src/types/index.ts', 'packages/service/src/index.ts', 'packages/service/src/service.ts']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/\b(NodeType|NodeCapabilities|BaseNodeConfig|PrimaryNodeConfig|enableLocalExec)\b/);
    }
  });
  it('keeps release-facing metadata and documentation on the unified entrypoint', () => {
    const lockText = readFileSync('package-lock.json', 'utf8');
    expect(lockText).not.toMatch(/@disclaude\/(?:primary|worker)-node|disclaude-worker/u);

    const releaseDocs = [
      'README.md',
      'docs/README.md',
      'docs/releases/git-install.md',
    ];
    for (const file of releaseDocs) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(
        /(?:packages\/(?:primary|worker)-node|disclaude-(?:primary|worker))/u,
      );
    }
  });
  it('starts Docker through the public CLI', () => {
    expect(readFileSync('Dockerfile.service', 'utf8')).toContain('CMD ["disclaude", "start"]');
    expect(readFileSync('docker-compose.yml', 'utf8')).toContain('command: ["disclaude", "start", "--api-port", "19200"]');
  });
  it('checks the child path actually launched by the public CLI', () => {
    const cli = readFileSync('bin/disclaude.js', 'utf8');
    expect(cli).toContain('node_modules/@disclaude/service/dist/cli.js');
    for (const file of ['Dockerfile.service', 'docker-compose.yml']) {
      const source = readFileSync(file, 'utf8');
      expect(source).toContain('[n]ode_modules/@disclaude/service/dist/cli.js');
      expect(source).not.toContain('"packages/service/dist/cli.js"');
    }
  });
  it('keeps release-facing Agent browser guidance on the IPC path', () => {
    const readme = readFileSync('README.md', 'utf8');
    const endpoint = readFileSync('docs/cdp-endpoint.md', 'utf8');
    expect(readme).toContain('[Browser coordination](docs/browser-coordination.md)');
    expect(endpoint).toContain('## Current Agent boundary');
    expect(endpoint).toContain('private IPC launcher');
    expect(endpoint).not.toContain('### Pointing drivers at the endpoint');
    expect(endpoint).not.toContain('## Skill ↔ CDP configuration contract');
    expect(endpoint).not.toContain('BU_CDP_URL=http://disclaude-chromium:9222 browser-use');
    expect(endpoint).not.toContain('fall back to native self-launch otherwise');
  });
});
